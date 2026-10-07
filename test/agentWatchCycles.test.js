const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { AgentRegistry } = require("../out/conversation/agents");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (content) =>
  JSON.stringify({
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content,
  }) + "\n";

async function waitUntil(predicate, maxMs = 5000, stepMs = 5) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error("Wait condition timed out");
    await delay(stepMs);
  }
}

test("AgentRegistry watcher resource lifecycle across 100 open/close cycles", { timeout: 60000 }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agy-watch-cycles-"));
  const dir1 = path.join(root, "agent-1", ".system_generated", "logs");
  const dir2 = path.join(root, "agent-2", ".system_generated", "logs");
  await fs.promises.mkdir(dir1, { recursive: true });
  await fs.promises.mkdir(dir2, { recursive: true });
  const file1 = path.join(dir1, "transcript.jsonl");
  const file2 = path.join(dir2, "transcript.jsonl");
  await fs.promises.writeFile(file1, "");
  await fs.promises.writeFile(file2, "");

  let changedCount = 0;
  const agents = [
    { id: "agent-1", role: "worker-1", state: "unknown", logUri: pathToFileURL(file1).href },
    { id: "agent-2", role: "worker-2", state: "unknown", logUri: pathToFileURL(file2).href },
  ];
  const registry = new AgentRegistry(agents, () => changedCount++, root);

  t.after(async () => {
    registry.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const bounds = { maxWatchers: 0, maxPending: 0 };

  for (let i = 0; i < 100; i++) {
    registry.watch(true);
    bounds.maxPending = Math.max(bounds.maxPending, registry.pendingWatches.size);
    await waitUntil(() => registry.watchers.size === 2 && registry.pendingWatches.size === 0);
    bounds.maxWatchers = Math.max(bounds.maxWatchers, registry.watchers.size);
    bounds.maxPending = Math.max(bounds.maxPending, registry.pendingWatches.size);

    const visibleSeen = changedCount;
    await fs.promises.appendFile(file1, line(`visible-cycle-${i}`));
    await waitUntil(() => changedCount > visibleSeen);

    // Close during a real pending debounce, not only after it has fired.
    await fs.promises.appendFile(file2, line(`cancel-cycle-${i}`));
    await waitUntil(() => registry.timer !== undefined);
    const beforeClose = changedCount;
    registry.watch(false);
    await waitUntil(() => registry.pendingWatches.size === 0);
    assert.equal(registry.watchers.size, 0, `cycle ${i}: watchers must be cleared on close`);
    assert.equal(registry.timer, undefined, `cycle ${i}: debounce timer must be canceled on close`);

    const hiddenSeen = changedCount;
    await fs.promises.appendFile(file2, line(`hidden-cycle-${i}`));
    await delay(110);
    assert.equal(changedCount, beforeClose, `cycle ${i}: closing canceled pending debounce`);
    assert.equal(changedCount, hiddenSeen, `cycle ${i}: no hidden callbacks should fire`);
    assert.equal(registry.timer, undefined, `cycle ${i}: timer must remain unset while hidden`);
  }

  assert.equal(bounds.maxWatchers, 2, "watchers must not exceed 2");
  assert.equal(bounds.maxPending, 2, "actual asynchronous pending watcher peak is observed");

  // Late pending resolution without monkeypatching: rapid watch toggle
  registry.watch(true);
  registry.watch(false);
  await waitUntil(() => registry.pendingWatches.size === 0);
  assert.equal(registry.watchers.size, 0, "late pending must not leave active watchers");
  assert.equal(registry.timer, undefined, "timer must remain undefined");

  // Disposal verification
  registry.dispose();
  assert.equal(registry.disposed, true, "registry should mark disposed");
  assert.equal(registry.watchers.size, 0, "disposed registry retains zero watchers");
});
