const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { FingerprintCache } = require("../out/conversation/fingerprintCache");
const { ConversationRepository } = require("../out/conversation/repository");
test("fingerprints bound count and bytes with LRU, retaining no source values", () => {
  const cache = new FingerprintCache(2, 400);
  const huge = "秘密中文🙂".repeat(100000);
  assert.equal(cache.matchesAndRemember("a", huge), false);
  assert.equal(cache.matchesAndRemember("a", huge), true);
  cache.matchesAndRemember("b", "b");
  cache.matchesAndRemember("a", huge);
  cache.matchesAndRemember("c", "c");
  assert.deepEqual([...cache.keys()], ["a", "c"]);
  assert(cache.snapshot.estimatedBytes <= 400);
  assert.equal(cache.size, 2);
  for (const entry of cache.entries.values()) {
    assert.deepEqual(Object.keys(entry), ["digest", "bytes"]);
    assert.equal(entry.digest.length, 64);
  }
  cache.matchesAndRemember("d".repeat(200), "value");
  assert.equal(cache.size, 2);
  assert.equal(cache.matchesAndRemember("a", "changed"), false);
  assert.equal(cache.matchesAndRemember("a", "changed"), true);
  cache.clear();
  assert.equal(cache.snapshot.estimatedBytes, 0);
  assert.throws(() => new FingerprintCache(-1, 5), /Invalid/);
});
test("byte budget evicts even below count limit, zero budget disables hints", () => {
  const cache = new FingerprintCache(1000, 150);
  cache.matchesAndRemember("a", "first");
  cache.matchesAndRemember("b", "second");
  assert.equal(cache.size, 1);
  assert.equal(cache.snapshot.evictions, 1);
  assert.equal(
    new FingerprintCache(0, 1000).matchesAndRemember("a", "value"),
    false,
  );
});
test("repository dedupe eviction preserves all persisted messages and complete tool originals", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fingerprint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const context = { globalStorageUri: { fsPath: root }, globalState: state };
  const repo = new ConversationRepository(context, true, undefined, {
    maxEntries: 2,
    maxBytes: 400,
  });
  const s = repo.createSession("cache", "m", "high");
  const outputs = new Map();
  for (let i = 0; i < 10; i++) {
    const output = ("完整工具🙂" + i).repeat(2000);
    outputs.set(i, output);
    s.messages.push({
      id: "message-" + i,
      role: "assistant",
      content: "正文" + i + "x".repeat(10000),
      timestamp: i,
      status: "completed",
      toolCalls: [{ stepIndex: i, name: "test", state: "DONE", output }],
    });
    repo.saveSession(s);
    await repo.flush();
    assert(repo.cacheStats.messages.entries <= 2);
    assert(repo.cacheStats.messages.estimatedBytes <= 400);
    assert(repo.cacheStats.tools.entries <= 2);
    assert(repo.cacheStats.tools.estimatedBytes <= 400);
  }
  // Resaving the entire transcript after eviction must not overwrite full originals with previews.
  repo.saveSession(s);
  await repo.flush();
  const restored = await ConversationRepository.open(context);
  const saved = await restored.getSessionAsync("cache");
  assert.equal(saved.messages.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(saved.messages[i].content, "正文" + i + "x".repeat(10000));
    assert.equal(
      (await restored.toolOutputAsync("cache", "message-" + i, i)).output,
      outputs.get(i),
    );
  }
  await repo.releaseTranscript("cache", () => true);
  assert.equal(repo.cacheStats.messages.entries, 0);
  assert.equal(repo.cacheStats.tools.entries, 0);
});
test("session prefix collision does not release another sessions fingerprints", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cache-prefix-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  for (const id of ["a", "ab"]) {
    const s = repo.createSession(id, "m", "high");
    s.messages = [
      {
        id: "reply",
        role: "assistant",
        content: "text",
        timestamp: 1,
        status: "completed",
      },
    ];
    repo.saveSession(s);
  }
  await repo.flush();
  await repo.releaseTranscript("a", () => true);
  assert([...repo.saved.keys()].every((key) => key.startsWith("ab\0")));
  assert.equal(repo.saved.size, 1);
});
test("LRU eviction cannot requeue unchanged pending tool originals on slow disk", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cache-pending-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const repo = new ConversationRepository(
    { globalStorageUri: { fsPath: root }, globalState: state },
    true,
    undefined,
    { maxEntries: 2, maxBytes: 400 },
  );
  const s = repo.createSession("pending", "m", "high");
  await repo.flush();
  s.messages = [
    {
      id: "reply",
      role: "assistant",
      content: "reply",
      timestamp: 1,
      status: "running",
      toolCalls: Array.from({ length: 10 }, (_, i) => ({
        stepIndex: i,
        name: "test",
        state: "DONE",
        output: ("raw🙂" + i).repeat(1000),
      })),
    },
  ];
  const outputs = s.messages[0].toolCalls.map((tool) => tool.output);
  const atomic = repo.atomic.bind(repo);
  let unblock, started;
  const gate = new Promise((resolve) => (unblock = resolve)),
    start = new Promise((resolve) => (started = resolve));
  let toolWrites = 0;
  repo.atomic = async (file, raw) => {
    if (file.includes(path.sep + "tools" + path.sep)) {
      if (++toolWrites === 1) {
        started();
        await gate;
      }
    }
    return atomic(file, raw);
  };
  try {
    repo.saveSession(s);
    await start;
    for (let i = 0; i < 100; i++) {
      s.messages[0].content = "reply" + i;
      s.messages[0].toolCalls = s.messages[0].toolCalls.map(tool => ({...tool}));
      repo.saveSession(s);
    }
    assert.equal(repo.checkpointWrites.get(s.id).tools.size, 0);
    assert(repo.cacheStats.tools.evictions > 0);
    unblock();
    await repo.flush();
    assert.equal(toolWrites, 10);
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await repo.toolOutputAsync(s.id, "reply", i)).output,
        outputs[i],
      );
  } finally {
    unblock();
    await repo.flush();
  }
});
