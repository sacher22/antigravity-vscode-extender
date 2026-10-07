const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ConversationRepository } = require("../out/conversation/repository");
const { ConversationController } = require("../out/conversation/controller");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("condition not met");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-real-pipe-"));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const repo = new ConversationRepository(
    { globalStorageUri: { fsPath: root }, globalState: state },
    true,
    { highBytes: 512 * 1024, lowBytes: 128 * 1024 },
  );
  const c = new ConversationController(
    {
      config: () => ({
        cliPath: path.join(__dirname, "fixtures/pressure-agy.cjs"),
        defaultModel: "custom-model",
        reasoningEffort: "high",
        dangerouslySkipPermissions: false,
      }),
      workspace: () => ({ root, directories: [root] }),
      log() {},
      setPermissions: async () => {},
      terminal() {},
    },
    repo,
  );
  let unblock, started;
  const gate = new Promise((r) => (unblock = r)),
    start = new Promise((r) => (started = r));
  const atomic = repo.atomic.bind(repo);
  let blocked = false;
  repo.atomic = async (file, raw) => {
    if (!blocked && file.includes(path.sep + "tools" + path.sep)) {
      blocked = true;
      started();
      await gate;
    }
    return atomic(file, raw);
  };
  let steps = 0;
  const transitions = [];
  repo.on("storagePressure", () =>
    transitions.push({
      at: Date.now(),
      paused: repo.writeQueueStats.paused,
      bytes: repo.writeQueueStats.estimatedBytes,
    }),
  );
  c.processManager.on("step_update", (step) => {
    if (step.step_type === "tool" && ++steps % 10 === 0) c.persistPartial();
  });
  t.after(async () => {
    unblock();
    await c.dispose();
    await repo.flush();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, repo, c, start, unblock, steps: () => steps, transitions };
}
test("real stdout backpressure stops drain-aware producer and resumes with every tool original intact", async (t) => {
  const f = await fixture(t);
  await f.c.sendMessage("burst");
  await f.start;
  await until(() => f.repo.writeQueueStats.paused);
  await delay(150);
  const pausedSteps = f.steps();
  const progress = JSON.parse(
    await fs.readFile(path.join(f.root, "progress.json"), "utf8"),
  );
  await delay(150);
  assert.equal(f.steps(), pausedSteps);
  assert(pausedSteps < 300);
  assert(progress.written < 300);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, "progress.json"), "utf8"))
      .written,
    progress.written,
  );
  f.unblock();
  await until(() => !f.c.processing);
  await f.repo.flush();
  assert.equal(f.steps(), 300);
  assert.equal(f.repo.writeQueueStats.estimatedBytes, 0);
  assert(f.transitions.some((item) => item.paused));
  assert(f.transitions.some((item) => !item.paused));
  console.log(
    JSON.stringify({
      probe: "real-pipe-resume",
      pausedSteps,
      producerPausedAt: progress.written,
      completedSteps: f.steps(),
      queue: f.repo.writeQueueStats,
      pressureTransitions: f.transitions.length,
    }),
  );
  const s = f.c.currentSessionMeta,
    reply = s.messages.find((message) => message.role === "assistant");
  assert.equal(reply.toolCalls.length, 300);
  for (let i = 0; i < 300; i++) {
    let output = "",
      offset = 0;
    for (;;) {
      const page = await f.repo.toolOutputAsync(s.id, reply.id, i + 1, offset);
      output += page.output;
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    assert.equal(output, ("工具原文🙂" + i + ":").repeat(4000));
  }
});
async function running(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    );
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return false;
    throw error;
  }
}
test("stopping while stdout is paused exits owned CLI and tool child before disk unblocks", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux process group");
  const f = await fixture(t);
  await f.c.sendMessage("hang-burst");
  await f.start;
  await until(() => f.repo.writeQueueStats.paused);
  const progress = JSON.parse(
    await fs.readFile(path.join(f.root, "progress.json"), "utf8"),
  );
  const toolPid = Number(
    await fs.readFile(path.join(f.root, "tool.pid"), "utf8"),
  );
  await until(async () => {
    try {
      await fs.stat(path.join(f.root, "tool.ready"));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  assert(await running(progress.pid));
  assert(await running(toolPid));
  const stoppedAt = performance.now();
  const stop = f.c.abortTurn();
  await until(
    async () => !(await running(progress.pid)) && !(await running(toolPid)),
  );
  const processTreeExitMs = performance.now() - stoppedAt;
  f.unblock();
  await stop;
  await f.repo.flush();
  assert.equal(f.c.processing, false);
  console.log(
    JSON.stringify({
      probe: "real-pipe-stop",
      processTreeExitMs,
      acceptedTools: f.steps(),
      queue: f.repo.writeQueueStats,
    }),
  );
  const reply = f.c.currentSessionMeta.messages.find(
    (message) => message.role === "assistant",
  );
  assert.equal(reply.status, "aborted");
  assert(reply.toolCalls.length > 0);
  assert(reply.toolCalls.length < 300);
});
