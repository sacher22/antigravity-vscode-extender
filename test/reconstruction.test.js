const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { ConversationRepository } = require("../out/conversation/repository");
const { ConversationController } = require("../out/conversation/controller");
const { AgyProcessManager } = require("../out/core/agyProcessManager");
const cli = path.join(__dirname, "fixtures/fake-agy.js");
const root = path.resolve(__dirname, "..");
function context(dir) {
  const a = new Map(),
    b = new Map();
  const state = (m) => ({
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    update: async (k, v) => m.set(k, v),
  });
  return {
    globalStorageUri: { fsPath: dir },
    globalState: state(a),
    workspaceState: state(b),
  };
}
function environment(dir = root) {
  return {
    config: () => ({
      cliPath: cli,
      defaultModel: "gemini-3.8-flash-high",
      reasoningEffort: "high",
      dangerouslySkipPermissions: false,
      autoScroll: true,
    }),
    workspace: (s) => ({ root: dir, directories: [dir] }),
    log() {},
    setPermissions: async () => {},
    terminal() {},
  };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test("copy includes complete active body before checkpoint and only loaded transcript bodies", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-copy-active-"));
  const repo = new ConversationRepository(context(tmp));
  const c = new ConversationController(environment(), repo);
  try {
    assert.equal(c.copyText(), "");
    const firstStep = once(c.processManager, "step_update");
    await c.sendMessage("hang");
    await firstStep;
    const text = "中文🙂".repeat(25000);
    c.processManager.emit("step_update", {step_index: 2, step_type: "agent_response", state: "ACTIVE", text_delta: text}, c.processManager.currentGeneration, Date.now());
    const body = c.copyText("last");
    assert(body.endsWith(text));
    const loaded = c.copyText("loaded");
    assert(loaded.startsWith("你\nhang"));
    assert(loaded.includes("Antigravity\n" + body));
    assert.equal(loaded.split(text).length, 2, "active body occurs exactly once");
    await c.abortTurn();
    assert.equal(c.copyText("last"), body);
    await repo.flush();
  } finally {
    await c.dispose();
    await repo.flush();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
test("tool detail asynchronously pages UTF-8 without synchronous disk access or silent invalid offsets", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tool-async-"));
  const repo = new ConversationRepository(context(tmp));
  const s = repo.createSession("async-tool", "m", "high");
  const text = "中文🙂".repeat(20000);
  s.messages = [{id: "answer", role: "assistant", content: "done", status: "completed", toolCalls: [{stepIndex: 1, name: "tool", state: "DONE", output: text}]}];
  repo.saveSession(s);
  await repo.flush();
  const saved = new Map(["openSync", "readSync", "statSync", "fstatSync"].map(name => [name, fs[name]]));
  try {
    for (const name of saved.keys()) fs[name] = () => {throw new Error("synchronous tool read");};
    let restored = "", offset = 0, page;
    do {
      page = await repo.toolOutputAsync(s.id, "answer", 1, offset);
      assert(page.nextOffset > offset);
      restored += page.output;
      offset = page.nextOffset;
    } while (page.hasMore);
    assert.equal(restored, text);
    assert.equal(offset, Buffer.byteLength(text));
    await assert.rejects(repo.toolOutputAsync(s.id, "answer", 1, -1), /页码/);
    await assert.rejects(repo.toolOutputAsync(s.id, "answer", 1, 1), /UTF-8/);
    await assert.rejects(repo.toolOutputAsync(s.id, "answer", 1, offset + 1), /变化/);
    assert.equal((await repo.toolOutputAsync(s.id, "missing", 1)).output, "");
  } finally {
    for (const [name, method] of saved) fs[name] = method;
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
test("active executor releases persisted tool originals and detail pages still return every byte", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-active-spool-"));
  const repo = new ConversationRepository(context(tmp), true, {highBytes: 65536, lowBytes: 16384});
  const c = new ConversationController(environment(), repo);
  const replies = [];
  let releaseWrite;
  let acknowledgement;
  c.on("message", message => {if (message.type === "toolDetail") replies.push(message);});
  try {
    const started = once(c.processManager, "step_update");
    await c.sendMessage("hang");
    await started;
    const original = "中文🙂".repeat(40000);
    const step = {step_index: 33, step_type: "tool", tool_name: "view_file", state: "DONE", tool_info: {output: original}};
    c.processManager.emit("step_update", step, c.processManager.currentGeneration, Date.now());
    c.persistPartial();
    await repo.flush();
    assert.equal(c.turn.tools.get(33).tool_info.output.length, 2048);
    assert(c.turn.storedTools.has(33));
    let copied = "", offset = 0;
    do {
      await c.toolDetail(c.turn.message.id, 33, offset);
      const page = replies.at(-1);
      assert(page.nextOffset > offset);
      copied += page.toolInfo.output;
      offset = page.nextOffset;
      if (!page.hasMore) break;
    } while (true);
    assert.equal(copied, original);
    c.persistPartial();
    await repo.flush();
    assert.equal((await repo.toolOutputAsync(c.currentSessionMeta.id, c.turn.message.id, 33)).hasMore, true, "preview is never written over the original");
    const atomic = repo.atomic.bind(repo);
    let reachedWrite, paused = false, sawOldAck = false;
    const startedWrite = new Promise(resolve => reachedWrite = resolve);
    const gate = new Promise(resolve => releaseWrite = resolve);
    repo.atomic = async (file, body) => {
      if (!paused && file.includes("/tools/")) {paused = true;reachedWrite();await gate;}
      return atomic(file, body);
    };
    const olderOutput = original + "first pending suffix";
    c.processManager.emit("step_update", {...step, tool_info: {output: olderOutput}}, c.processManager.currentGeneration, Date.now());
    c.persistPartial();
    await startedWrite;
    assert.equal(c.processManager.outputPaused, true);
    const updated = original + "new suffix";
    acknowledgement = event => {
      if (event.output === olderOutput) {
        assert.equal(c.turn.tools.get(33).tool_info.output, updated, "late disk acknowledgement cannot trim newer output");
        assert.equal(c.turn.storedTools.has(33), false);
        sawOldAck = true;
      }
    };
    repo.on("toolOutputPersisted", acknowledgement);
    c.processManager.emit("step_update", {...step, tool_info: {output: updated}}, c.processManager.currentGeneration, Date.now());
    assert.equal(c.turn.storedTools.has(33), false);
    assert.equal(c.turn.tools.get(33).tool_info.output, updated);
    c.persistPartial();
    releaseWrite();
    await repo.flush();
    assert(sawOldAck);
    assert.equal(c.processManager.outputPaused, false);
    assert.equal(repo.writeQueueStats.estimatedBytes, 0);
    await c.abortTurn();
    await repo.flush();
    let output = "";offset = 0;
    do {
      const page = await repo.toolOutputAsync(c.currentSessionMeta.id, c.currentSessionMeta.messages.at(-1).id, 33, offset);
      output += page.output;offset = page.nextOffset;
      if (!page.hasMore) break;
    } while (true);
    assert.equal(output, updated);
  } finally {
    releaseWrite?.();
    if (acknowledgement) repo.off("toolOutputPersisted", acknowledgement);
    await c.dispose();
    await repo.flush();
    assert.equal(repo.listenerCount("toolOutputPersisted"), 0);
    assert.equal(repo.listenerCount("storagePressure"), 0);
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
test("completion delivers metadata instead of retransmitting the streamed transcript, and result-only text remains recoverable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-finalization-"));
  const repo = new ConversationRepository(context(tmp));
  const c = new ConversationController(environment(), repo);
  const messages = [];
  c.on("message", message => messages.push(message));
  try {
    const firstStep = once(c.processManager, "step_update");
    await c.sendMessage("hang");
    await firstStep;
    const generation = c.processManager.currentGeneration;
    c.processManager.emit("step_update", {step_index: 2, step_type: "agent_response", state: "ACTIVE", text_delta: "x".repeat(1000000)}, generation, Date.now());
    const boundary = messages.length;
    c.processManager.emit("result", {status: "SUCCESS", response: "x".repeat(1000000)}, generation, Date.now());
    const finalized = messages.slice(boundary).find(message => message.type === "turnComplete");
    assert(finalized);
    assert.equal(finalized.result.response, undefined);
    assert.equal(finalized.changes.content, undefined);
    assert.equal(finalized.changes.toolCalls, undefined);
    assert.equal(finalized.changes.status, "completed");
    assert(JSON.stringify(finalized).length < 4096);
    assert(!messages.slice(boundary).some(message => message.type === "initSession"));
    assert(c.currentSessionMeta.messages.at(-1).content.includes("x".repeat(1000000)));
    c.sendSnapshot();
    assert(messages.findLast(message => message.type === "initSession").session.messages.at(-1).content.includes("x".repeat(1000000)));
    const resultOnly = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("result-only completion timed out")), 3000);
      const listener = message => {
        if (message.type === "turnComplete" && message.changes?.content) {
          clearTimeout(timer);
          c.off("message", listener);
          resolve(message);
        }
      };
      c.on("message", listener);
    });
    await c.sendMessage("result-only");
    const response = await resultOnly;
    assert.equal(response.changes.content, "result without streamed steps");
    assert.equal(response.changes.blocks[0].text, response.changes.content);
    await repo.flush();
    assert.equal(new ConversationRepository(context(tmp)).getSession(c.currentSessionMeta.id).messages.at(-1).content, response.changes.content);
  } finally {
    await c.dispose();
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
test("backend materializes only latest 30 messages; older history pages remain ordered", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-page-"));
  try {
    let r = new ConversationRepository(context(tmp));
    const s = r.createSession("local", "m", "high");
    s.messages = Array.from({ length: 95 }, (_, i) => ({
      id: "m" + i,
      role: "user",
      content: "message" + i,
      timestamp: i,
    }));
    r.saveSession(s);
    await r.flush();
    r = new ConversationRepository(context(tmp));
    const restored = r.getSession("local");
    assert.equal(restored.messages.length, 30);
    assert.equal(restored.messages[0].content, "message65");
    const page = r.page("local", 65);
    assert.equal(page.messages[0].content, "message35");
    assert.equal(page.hasMore, true);
    assert.equal(r.page("local", 35).messages[0].content, "message5");
    assert.equal(r.page("local", 5).messages.length, 5);
    r.saveSession(restored);
    await r.flush();
    assert.equal(
      new ConversationRepository(context(tmp)).getSession("local").messageCount,
      95,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("complete large tool outputs survive restart and are separate from message summaries", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tool-"));
  try {
    const r = new ConversationRepository(context(tmp));
    const s = r.createSession("local", "m", "high");
    s.messages = [
      {
        id: "a",
        role: "assistant",
        content: "done",
        timestamp: 1,
        toolCalls: [
          {
            stepIndex: 1,
            name: "run_command",
            state: "DONE",
            output: "x".repeat(150000),
          },
        ],
      },
    ];
    r.saveSession(s);
    await r.flush();
    const restored = new ConversationRepository(context(tmp));
    assert.equal(
      restored.getSession("local").messages[0].toolCalls[0].output.length,
      2048,
    );
    assert.equal(restored.toolOutput("local", "a", 1).output.length, 65536);
    assert.equal(restored.toolOutput("local", "a", 1, 65536).hasMore, true);
    restored.saveSession(restored.getSession("local"));
    await restored.flush();
    assert.equal(
      restored.toolOutput("local", "a", 1, 131072).output.length,
      18928,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("two repositories cannot execute same CLI conversation; release allows next owner", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lock-"));
  try {
    const a = new ConversationRepository(context(tmp)),
      b = new ConversationRepository(context(tmp));
    const release = a.acquire("cli-shared");
    assert.throws(() => b.acquire("cli-shared"), /另一个/);
    release();
    b.acquire("cli-shared")();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("connecting stop is interruptible; process crash restores idle; new retains settings and defaults normal", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-controller-"));
  const repo = new ConversationRepository(context(tmp));
  const c = new ConversationController(environment(), repo);
  try {
    const local = c.prepareOrSwitchSessionUI().id;
    await c.setModel("slow-init", "high");
    c.saveDraft("preserved");
    const start = c.sendMessage("hello");
    const rejected = assert.rejects(start, /取消|cancelled/);
    await delay(20);
    await c.abortTurn();
    await rejected;
    assert.equal(c.processing, false);
    assert.equal(c.currentSessionMeta.draft, "preserved");
    assert.equal(c.currentSessionMeta.id, local);
    await c.setModel("gemini-3.8-flash-high", "high");
    const done = once(c, "message").catch(() => {});
    await c.sendMessage("crash");
    await delay(80);
    assert.equal(c.processing, false);
    assert.equal(c.currentSessionMeta.messages.at(-1).status, "failed");
    await c.setPlanMode(true);
    await Promise.all([c.newSession(), c.newSession()]);
    assert.notEqual(c.currentSessionMeta.id, local);
    assert.equal(c.currentSessionMeta.planMode, false);
    assert.equal(c.currentSessionMeta.effort, "high");
  } finally {
    await c.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("stop removes CLI-owned tool descendants", async () => {
  const manager = new AgyProcessManager();
  try {
    await manager.start({ cliPath: cli, cwd: root });
    const step = once(manager, "step_update");
    await manager.sendMessage("hang");
    const [s] = await step;
    const pid = Number(s.text_delta.split(":")[1]);
    assert.ok(pid);
    await manager.abortCurrentTurn();
    await delay(50);
    let state;
    try {
      state = fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(" ")[2];
    } catch (e) {
      assert.equal(e.code, "ENOENT");
    }
    assert.ok(!state || state === "Z", "owned tool is no longer running");
  } finally {
    await manager.stop();
  }
});
test("different-workspace histories are preserved and prompts execute in a new local conversation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cross-"));
  const repo = new ConversationRepository(context(tmp));
  const old = repo.createSession("legacy", "m", "high");
  old.workspaceRoot = "/another-project";
  old.cliConversationId = "old-cli";
  old.messages = [{ id: "u", role: "user", content: "keep", timestamp: 1 }];
  repo.saveSession(old);
  const c = new ConversationController(environment(), repo);
  try {
    c.prepareOrSwitchSessionUI("legacy");
    await c.sendMessage("new prompt");
    await delay(40);
    assert.notEqual(c.currentSessionMeta.id, "legacy");
    assert.equal(c.currentSessionMeta.workspaceRoot, root);
    assert.equal(repo.getSession("legacy").messages[0].content, "keep");
    assert.equal(c.currentSessionMeta.messages[0].content, "new prompt");
  } finally {
    await c.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("cross-project Plan stays read-only despite Danger default and preserves original history", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plan-redirect-"));
  const repo = new ConversationRepository(context(tmp));
  const old = repo.createSession("plan-old", "gemini-3.8-flash-high", "high");
  old.workspaceRoot = "/another-project";
  old.planMode = true;
  old.messages = [
    { id: "previous", role: "user", content: "keep", timestamp: 1 },
  ];
  repo.saveSession(old);
  const env = environment(tmp);
  const config = env.config();
  env.config = () => ({ ...config, dangerouslySkipPermissions: true });
  const c = new ConversationController(env, repo);
  try {
    c.prepareOrSwitchSessionUI(old.id);
    await c.sendMessage("propose only");
    assert.notEqual(c.currentSessionMeta.id, old.id);
    assert.equal(c.currentSessionMeta.planMode, true);
    assert.equal(
      c.processManager.initInfo.agent,
      require("../out/core/planAgent").PLAN_AGENT,
    );
    assert.equal(c.processManager.initInfo.permission_mode, "request-review");
    assert.equal(repo.getSession(old.id).messages[0].content, "keep");
  } finally {
    await c.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("legacy Plan native cwd mismatch redirects into another read-only CLI", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-legacy-plan-"));
  const repo = new ConversationRepository(context(tmp));
  const old = repo.createSession(
    "legacy-plan",
    "gemini-3.8-flash-high",
    "high",
  );
  old.planMode = true;
  old.planAgentVersion = 1;
  old.cliConversationId = "legacy-cwd-mismatch";
  repo.saveSession(old);
  const env = environment(tmp);
  const config = env.config();
  env.config = () => ({ ...config, dangerouslySkipPermissions: true });
  const c = new ConversationController(env, repo);
  try {
    c.prepareOrSwitchSessionUI(old.id);
    await c.sendMessage("propose only");
    assert.notEqual(c.currentSessionMeta.id, old.id);
    assert.equal(c.currentSessionMeta.planMode, true);
    assert.equal(c.processManager.initInfo.permission_mode, "request-review");
    assert.equal(c.processManager.initInfo.cwd, tmp);
    assert.equal(
      c.processManager.initInfo.agent,
      require("../out/core/planAgent").PLAN_AGENT,
    );
  } finally {
    await c.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tool output growth survives failed checkpoint and subsequent retry", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tool-retry-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    const s = repo.createSession("tool-retry", "m", "high");
    const tool = {
      stepIndex: 1,
      name: "shell",
      state: "ACTIVE",
      output: "initial",
    };
    s.messages.push({
      id: "msg",
      role: "assistant",
      content: "",
      timestamp: 1,
      status: "running",
      toolCalls: [tool],
    });
    repo.saveSession(s);
    await repo.flush();
    const atomic = repo.atomic.bind(repo);
    let fail = true;
    repo.atomic = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("disk fault");
      }
      return atomic(...args);
    };
    const originalOutput = "grown".repeat(20000);
    tool.output = originalOutput;
    repo.saveSession(s);
    await assert.rejects(repo.flush(), /disk fault/);
    assert.equal(repo.writePausedFor(s.id), true);
    assert.equal(repo.writePausedFor("unrelated-session"), false);
    assert.equal(repo.writeQueueStats.estimatedBytes, 0);
    assert.equal(tool.output, originalOutput, "failed commit retains complete in-memory original");
    repo.saveMetadata(s);
    await repo.flush();
    assert.equal(repo.writePausedFor(s.id), true, "metadata success cannot certify the failed tool original");
    repo.saveSession(s);
    await repo.flush();
    const page = repo.toolOutput(s.id, "msg", 1);
    assert.equal(repo.writePausedFor(s.id), false);
    assert.equal(page.output, originalOutput.slice(0, page.nextOffset));
    assert.equal(page.hasMore, true);
  } finally {
    await repo.flush().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("draft metadata does not serialize loaded history; transcript eviction restores complete history", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-metadata-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    const s = repo.createSession("cached", "m", "high");
    s.messages = Array.from({ length: 60 }, (_, i) => ({
      id: "cache-" + i,
      role: "user",
      content: "large".repeat(1000),
      timestamp: i,
    }));
    repo.saveSession(s);
    await repo.flush();
    let serialization = 0;
    const message = s.messages[0];
    message.toJSON = () => {
      serialization++;
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      };
    };
    s.draft = "first";
    repo.saveMetadata(s);
    s.draft = "latest";
    repo.saveMetadata(s);
    await repo.flush();
    assert.equal(serialization, 0);
    await repo.releaseTranscript(s.id, () => true);
    assert.equal(s.messages.length, 0);
    assert.equal(repo.loaded.has(s.id), false);
    const restored = repo.getSession(s.id);
    assert.equal(restored.messages.length, 30);
    assert.equal(restored.messageCount, 60);
    assert.equal(restored.draft, "latest");
    assert.equal(repo.page(s.id, 30).messages.length, 30);
  } finally {
    await repo.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("100 persisted session visits evict transcript caches while retaining metadata and recoverable messages", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cache-visits-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    for (let i = 0; i < 100; i++) {
      const s = repo.createSession("visit-" + i, "m", "high");
      s.messages = [
        {
          id: "message-" + i,
          role: "assistant",
          content: "x".repeat(100000),
          timestamp: i,
          status: "completed",
        },
      ];
      repo.saveSession(s);
      await repo.releaseTranscript(s.id, () => true);
    }
    for (let i = 0; i < 100; i++) {
      const s = repo.getSession("visit-" + i);
      assert.equal(s.messages[0].content.length, 100000);
      await repo.releaseTranscript(s.id, () => true);
    }
    assert.equal(repo.loaded.size, 0);
    assert.equal(repo.saved.size, 0);
    assert.equal(repo.files.size, 0);
    assert.equal(repo.getAllSessions().length, 100);
  } finally {
    await repo.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("async session and history pages avoid synchronous message reads and retain ordering", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-async-history-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    const s = repo.createSession("async", "m", "high");
    s.messages = Array.from({ length: 90 }, (_, i) => ({
      id: "async-" + i,
      role: "user",
      content: "message " + i,
      timestamp: i,
    }));
    repo.saveSession(s);
    await repo.releaseTranscript(s.id, () => true);
    repo.readFiles = () => {
      throw new Error("synchronous history read forbidden");
    };
    const restored = await repo.getSessionAsync(s.id);
    assert.equal(restored.messages[0].content, "message 60");
    const page = await repo.pageAsync(s.id, 60);
    assert.equal(page.messages[0].content, "message 30");
    assert.equal(page.hasMore, true);
    const oldest = await repo.pageAsync(s.id, 30);
    assert.equal(oldest.messages[0].content, "message 0");
    assert.equal(oldest.hasMore, false);
  } finally {
    await repo.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("dirty message checkpoints skip immutable history serialization and recover changed output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dirty-checkpoint-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    const s = repo.createSession("dirty", "m", "high");
    s.messages = Array.from({ length: 80 }, (_, i) => ({
      id: "dirty-" + i,
      role: "assistant",
      content: "old " + i,
      timestamp: i,
      status: "completed",
    }));
    repo.saveSession(s);
    await repo.flush();
    let reads = 0;
    s.messages[0].toJSON = () => {
      reads++;
      throw new Error("immutable history serialized");
    };
    s.messages[79].content = "updated";
    repo.saveSession(s, ["dirty-79"]);
    await repo.flush();
    assert.equal(reads, 0);
    assert.equal(s.messageCount, 80);
    const reopened = new ConversationRepository(context(tmp));
    const restored = await reopened.getSessionAsync("dirty");
    assert.equal(restored.messages.at(-1).content, "updated");
    assert.equal(restored.messageCount, 80);
  } finally {
    await repo.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("running and final checkpoints release unchanged tool output memory while spool retains full content", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tool-release-"));
  const repo = new ConversationRepository(context(tmp));
  try {
    const s = repo.createSession("release", "m", "high");
    const tool = {
      stepIndex: 1,
      name: "tool",
      state: "DONE",
      output: "x".repeat(200000),
    };
    const message = {
      id: "output",
      role: "assistant",
      content: "done",
      timestamp: 1,
      status: "running",
      toolCalls: [tool],
    };
    s.messages = [message];
    repo.saveSession(s);
    await repo.flush();
    assert.equal(tool.output.length, 2048);
    assert.equal((await repo.toolOutputAsync(s.id, "output", 1)).hasMore, true);
    message.status = "completed";
    repo.saveSession(s, ["output"]);
    await repo.flush();
    assert.equal(tool.output.length, 2048);
    assert.equal(repo.toolOutput(s.id, "output", 1).output.length, 65536);
    repo.saveMetadata(s);
    await repo.flush();
    assert.equal(repo.toolOutput(s.id, "output", 1).hasMore, true);
  } finally {
    await repo.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("corrupt records are isolated while valid legacy sources and rollback originals survive", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-migration-"));
  try {
    const old = path.join(tmp, "sessions-v2");
    fs.mkdirSync(old);
    fs.writeFileSync(
      path.join(old, "index.json"),
      JSON.stringify([
        { id: "bad", title: "broken", messages: [{ content: null }] },
      ]),
    );
    const r = new ConversationRepository(context(tmp));
    await r.flush();
    assert.ok(fs.existsSync(path.join(old, "index.json")));
    assert.ok(
      fs.readdirSync(path.join(tmp, "conversations-v3", "quarantine")).length,
    );
    assert.equal(r.getSession("bad"), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("storage failures are visible, keep the draft, and allow a subsequent save to retry", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-retry-"));
  try {
    const r = new ConversationRepository(context(tmp));
    const s = r.createSession("retry", "m", "high");
    await r.flush();
    let fail = true;
    const atomic = r.atomic.bind(r);
    r.atomic = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("disk fault");
      }
      return atomic(...args);
    };
    s.draft = "keep draft";
    r.saveSession(s);
    await assert.rejects(r.flush(), /disk fault/);
    assert.equal(s.draft, "keep draft");
    r.saveSession(s);
    await r.flush();
    assert.equal(
      new ConversationRepository(context(tmp)).getSession("retry").draft,
      "keep draft",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("whole-session v2 migration preserves originals and separates local and CLI identity", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-whole-"));
  try {
    const dir = path.join(tmp, "sessions-v2");
    fs.mkdirSync(dir);
    const meta = {
      id: "cli-legacy",
      title: "legacy",
      createdAt: 1,
      updatedAt: 1,
      model: "m",
      effort: "high",
      totalTokens: 0,
    };
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify([meta]));
    const f = path.join(
      dir,
      require("crypto").createHash("sha256").update(meta.id).digest("hex") +
        ".json",
    );
    fs.writeFileSync(
      f,
      JSON.stringify({
        ...meta,
        messages: [{ role: "assistant", content: "original", timestamp: 1 }],
      }),
    );
    const r = new ConversationRepository(context(tmp));
    assert.equal(r.getSession(meta.id).cliConversationId, meta.id);
    assert.equal(r.getSession(meta.id).messages[0].content, "original");
    assert.ok(fs.existsSync(f));
    assert.ok(
      fs.existsSync(path.join(tmp, "conversations-v3", "migration.json")),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Plan mismatched init agent stops the actual CLI before any stdin and releases only the confirmed execution claim',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-plan-agent-mismatch-'));
  const ctx=context(tmp),repo=new ConversationRepository(ctx),c=new ConversationController(environment(tmp),repo);
  const manager=c.processManager,start=manager.start.bind(manager),send=manager.sendMessage.bind(manager);
  let pid,submitted=0;
  try {
    await c.setPlanMode(true);const session=c.currentSessionMeta;
    manager.start=async options=>{const id=await start(options);pid=manager.processPid;manager.initInfo.agent='unexpected-agent';return id;};
    manager.sendMessage=async(...args)=>{submitted++;return send(...args);};
    await assert.rejects(c.sendMessage('only plan'),/CLI 未启用只读 Plan Agent/);
    assert.equal(submitted,0);assert.equal(manager.active,false);assert.equal(manager.exitConfirmed,true);
    assert.equal(c.processing,false);assert.equal(session.planMode,true);assert.equal(session.draft,'only plan');
    assert.equal(session.messages.length,0);await repo.flush();
    assert(pid);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
    const other=new ConversationRepository(ctx),release=other.acquireExecution(session.id);release();
  } finally {manager.start=start;manager.sendMessage=send;await c.dispose();await repo.flush();fs.rmSync(tmp,{recursive:true,force:true});}
});
