const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { AgentRegistry } = require("../out/conversation/agents");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (content) =>
  JSON.stringify({
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content,
    thinking: "PRIVATE",
  }) + "\n";
async function fixture(t) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "agy-agent-log-"),
  );
  const dir = path.join(root, "child", ".system_generated/logs");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, "transcript.jsonl");
  await fs.promises.writeFile(file, "");
  let changed = 0;
  const registry = new AgentRegistry(
    [
      {
        id: "child",
        role: "research",
        state: "unknown",
        logUri: pathToFileURL(file).href,
      },
    ],
    () => changed++,
    root,
  );
  t.after(async () => {
    registry.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, file, registry, changes: () => changed };
}
test("async agent pages preserve fragmented Unicode/public projection without synchronous I/O", async (t) => {
  const { file, registry } = await fixture(t);
  const first = Buffer.from(line("first中文🙂"));
  const second = Buffer.from(line("later中文🙂"));
  const split = second.indexOf(Buffer.from("🙂")) + 1;
  await fs.promises.writeFile(
    file,
    Buffer.concat([first, second.subarray(0, split)]),
  );
  const sync = fs.realpathSync;
  fs.realpathSync = () => {
    throw new Error("unexpected sync IO");
  };
  try {
    const page = await registry.detailAsync("child");
    assert(page.text.includes("first中文🙂"));
    assert(!page.text.includes("PRIVATE"));
    assert.equal(page.nextOffset, first.length);
    assert.equal(page.hasMore, true);
    const incomplete = await registry.detailAsync("child", page.nextOffset);
    assert.equal(incomplete.text, "");
    assert.equal(incomplete.nextOffset, page.nextOffset);
    await fs.promises.appendFile(file, second.subarray(split));
    const complete = await registry.detailAsync("child", page.nextOffset);
    assert(complete.text.includes("later中文🙂"));
    assert.equal(complete.hasMore, false);
  } finally {
    fs.realpathSync = sync;
  }
});
test("async agent pagination rejects replacement/truncation/rewrites and retains prior cursor", async (t) => {
  const { file, registry } = await fixture(t);
  const old = line("old");
  await fs.promises.writeFile(file, old);
  const page = await registry.detailAsync("child");
  const prior = registry.cursors.get("child");
  await fs.promises.rename(file, file + ".original");
  await fs.promises.writeFile(file, line("replacement longer"));
  await assert.rejects(registry.detailAsync("child", page.nextOffset), /替换/);
  assert.equal(registry.cursors.get("child"), prior);
  await fs.promises.unlink(file);
  await fs.promises.rename(file + ".original", file);
  await fs.promises.writeFile(file, line("new"));
  await assert.rejects(registry.detailAsync("child", page.nextOffset), /改写/);
  assert.equal(registry.cursors.get("child"), prior);
  await fs.promises.truncate(file, 0);
  await assert.rejects(registry.detailAsync("child", page.nextOffset), /截断/);
  assert.equal(registry.cursors.get("child"), prior);
  await fs.promises.writeFile(file, line("fresh"));
  assert((await registry.detailAsync("child", 0)).text.includes("fresh"));
});
test("pending watcher resolution cannot create hidden/disposed subscriptions", async (t) => {
  const f = await fixture(t);
  let unblock;
  const gate = new Promise((r) => (unblock = r));
  const original = f.registry.logPathAsync.bind(f.registry);
  f.registry.logPathAsync = async (a) => {
    await gate;
    return original(a);
  };
  f.registry.watch(true);
  f.registry.watch(false);
  unblock();
  for (let i = 0; i < 100 && f.registry.pendingWatches.size; i++)
    await delay(5);
  assert.equal(f.registry.watchers.size, 0);
  f.registry.watch(true);
  for (let i = 0; i < 100 && !f.registry.watchers.size; i++) await delay(5);
  assert.equal(f.registry.watchers.size, 1);
  f.registry.dispose();
  await fs.promises.appendFile(f.file, line("after"));
  await delay(120);
  assert.equal(f.changes(), 0);
  assert.equal(f.registry.watchers.size, 0);
  await assert.rejects(f.registry.detailAsync("child"), /关闭/);
});
test("async agent path rejection and file disappearance do not silently advance cursor", async (t) => {
  const { file, registry } = await fixture(t);
  await fs.promises.writeFile(file, line("visible"));
  const page = await registry.detailAsync("child");
  const prior = registry.cursors.get("child");
  await fs.promises.unlink(file);
  await assert.rejects(
    registry.detailAsync("child", page.nextOffset),
    /ENOENT/,
  );
  assert.equal(registry.cursors.get("child"), prior);
  registry.agents.get("child").logUri = pathToFileURL("/etc/passwd").href;
  await assert.rejects(registry.detailAsync("child"), /目录/);
});
test("replacement during an async read is rejected before cursor commit", async (t) => {
  const { file, registry } = await fixture(t);
  await fs.promises.writeFile(file, line("old"));
  const first = await registry.detailAsync("child");
  const prior = registry.cursors.get("child");
  await fs.promises.appendFile(file, line("append"));
  const original = registry.logPathAsync.bind(registry);
  let calls = 0;
  registry.logPathAsync = async (a) => {
    if (++calls === 2) {
      await fs.promises.rename(file, file + ".old");
      await fs.promises.writeFile(file, line("replacement"));
    }
    return original(a);
  };
  await assert.rejects(registry.detailAsync("child", first.nextOffset), /替换/);
  assert.equal(registry.cursors.get("child"), prior);
});
