const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ConversationRepository } = require("../out/conversation/repository");
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-draft-checkpoint-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const context = { globalStorageUri: { fsPath: root }, globalState: state };
  const repo = new ConversationRepository(context);
  const s = repo.createSession("draft", "m", "high");
  await repo.flush();
  const atomic = repo.atomic.bind(repo);
  let unblock, started;
  const gate = new Promise((r) => (unblock = r)),
    start = new Promise((r) => (started = r));
  let messageWrites = 0;
  repo.atomic = async (file, raw) => {
    if (
      file.includes(path.sep + "messages" + path.sep) &&
      ++messageWrites === 1
    ) {
      started();
      await gate;
    }
    return atomic(file, raw);
  };
  s.messages = [
    {
      id: "reply",
      role: "assistant",
      content: "initial",
      timestamp: 1,
      status: "running",
    },
  ];
  repo.saveSession(s);
  await start;
  return { repo, s, context, unblock, writes: () => messageWrites };
}
test("draft typing preserves checkpoint coalescing and latest draft under slow writes", async (t) => {
  const f = await fixture(t);
  const { repo, s } = f;
  try {
    for (let i = 0; i < 100; i++) {
      s.messages[0].content = "latest-" + i;
      repo.saveSession(s);
      s.draft = "草稿🙂" + i;
      repo.saveDraftMetadata(s);
    }
    assert.equal(repo.writeQueueStats.batches, 2);
    assert.equal(repo.checkpointWrites.size, 1);
    assert.equal(repo.metadataWrites.size, 0);
    const pending = repo.checkpointWrites.get(s.id);
    const stored = [...pending.messages.values()][0];
    assert.deepEqual(Object.keys(stored), ["name", "text", "messageId", "status"]);
    assert.equal(stored.messageId, "reply");
    assert.equal(JSON.parse(stored.text).content, "latest-99");
    s.model = "not-committed";
    s.draft = "final";
    repo.saveDraftMetadata(s);
    assert.equal(JSON.parse(pending.raw).model, "m");
    f.unblock();
    await repo.flush();
    assert.equal(f.writes(), 2);
    const restored = await ConversationRepository.open(f.context);
    const saved = await restored.getSessionAsync(s.id);
    assert.equal(saved.messages[0].content, "latest-99");
    assert.equal(saved.draft, "final");
    assert.equal(saved.model, "m");
  } finally {
    f.unblock();
    await repo.flush();
  }
});
test("explicit configuration metadata still seals the checkpoint merge boundary", async (t) => {
  const f = await fixture(t);
  const { repo, s } = f;
  try {
    s.messages[0].content = "before config";
    repo.saveSession(s);
    const before = repo.checkpointWrites.get(s.id);
    s.model = "next-model";
    repo.saveMetadata(s);
    assert.equal(repo.checkpointWrites.has(s.id), false);
    s.messages[0].content = "after config";
    repo.saveSession(s);
    const after = repo.checkpointWrites.get(s.id);
    assert.notEqual(before, after);
    assert.equal(JSON.parse(before.raw).model, "m");
    assert.equal(JSON.parse(after.raw).model, "next-model");
    assert.equal(repo.writeQueueStats.batches, 4);
    f.unblock();
    await repo.flush();
    assert.equal(f.writes(), 3);
    const restored = await ConversationRepository.open(f.context);
    const saved = await restored.getSessionAsync(s.id);
    assert.equal(saved.model, "next-model");
    assert.equal(saved.messages[0].content, "after config");
  } finally {
    f.unblock();
    await repo.flush();
  }
});
test("persisted tool previews do not reenter trim bookkeeping on text-only checkpoints", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-preview-trims-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  const s = repo.createSession("previews", "m", "high");
  const output = "工具🙂".repeat(20000);
  s.messages = [
    {
      id: "reply",
      role: "assistant",
      content: "initial",
      timestamp: 1,
      status: "running",
      toolCalls: [{ name: "test", stepIndex: 1, state: "DONE", output }],
    },
  ];
  repo.saveSession(s);
  await repo.flush();
  assert.equal(s.messages[0].toolCalls[0].output.length, 2048);
  let committed = 0;
  repo.on("toolOutputPersisted", () => committed++);
  s.messages[0].content = "text changed";
  repo.saveSession(s);
  const batch = repo.checkpointWrites.get(s.id);
  assert.equal(batch.trims.size, 0);
  assert.equal(batch.tools.size, 0);
  await repo.flush();
  assert.equal(committed, 0);
  let offset = 0,
    restored = "";
  for (;;) {
    const page = await repo.toolOutputAsync(s.id, "reply", 1, offset);
    restored += page.output;
    if (!page.hasMore) break;
    offset = page.nextOffset;
  }
  assert.equal(restored, output);
});
