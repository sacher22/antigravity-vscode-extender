const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {WriteBudget} = require("../out/conversation/writeBudget");
const {ConversationRepository} = require("../out/conversation/repository");

test("write budget counts in-flight owners, replaces revisions and uses hysteresis", () => {
  const changes = [];
  const budget = new WriteBudget(paused => changes.push(paused), 100, 20);
  const a = {}, b = {};
  budget.retain(a, 80);budget.retain(b, 30);
  assert.equal(budget.snapshot.estimatedBytes, 110);
  budget.retain(a, 10);
  assert.equal(budget.snapshot.paused, true);
  budget.release(b);
  assert.equal(budget.snapshot.paused, false);
  budget.release(a);budget.release(a);
  assert.equal(budget.snapshot.estimatedBytes, 0);
  assert.equal(budget.snapshot.peakEstimatedBytes, 110);
  assert.deepEqual(changes, [true, false]);
  assert.throws(() => budget.retain(a, -1));
});

test("global budget transitions notify other sessions while a failed session remains paused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-pressure-scope-"));
  const state = {get: (_, fallback) => fallback, update: async () => {}};
  const repo = new ConversationRepository({globalStorageUri: {fsPath: root}, globalState: state}, true,
    {highBytes: 4096, lowBytes: 1024});
  const a = repo.createSession("a", "m", "high");
  const b = repo.createSession("b", "m", "high");
  await repo.flush();
  const atomic = repo.atomic.bind(repo);
  let release;
  try {
    repo.atomic = async () => {throw new Error("disk full");};
    a.messages = [{id: "a-message", role: "user", content: "must retry"}];
    repo.saveSession(a);
    await assert.rejects(repo.flush(), /disk full/);
    assert.equal(repo.writePausedFor(a.id), true);
    assert.equal(repo.writePausedFor(b.id), false);
    let arrived;
    const started = new Promise(resolve => arrived = resolve);
    const gate = new Promise(resolve => release = resolve);
    repo.atomic = async (...args) => {arrived();await gate;return atomic(...args);};
    const transitions = [];
    repo.on("storagePressure", () => transitions.push(repo.writePausedFor(b.id)));
    b.messages = [{id: "b-message", role: "user", content: "x".repeat(10000)}];
    repo.saveSession(b);
    await started;
    assert.equal(repo.writePausedFor(b.id), true);
    release();await repo.flush();
    assert.equal(repo.writePausedFor(a.id), true);
    assert.equal(repo.writePausedFor(b.id), false);
    assert.deepEqual(transitions, [true, false]);
    repo.atomic = atomic;
    repo.saveSession(a);await repo.flush();
    assert.equal(repo.writePausedFor(a.id), false);
    assert.equal(repo.writeQueueStats.estimatedBytes, 0);
  } finally {
    release?.();repo.atomic = atomic;
    await repo.flush().catch(() => {});
    await fs.rm(root, {recursive: true, force: true});
  }
});
