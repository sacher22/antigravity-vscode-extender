const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { ConversationRepository } = require("../out/conversation/repository");
const { transcriptBytes } = require("../out/conversation/transcriptBudget");
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-transcript-budget-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const context = { globalStorageUri: { fsPath: root }, globalState: state };
  const repo = new ConversationRepository(context);
  for (let i = 0; i < 6; i++) {
    const s = repo.createSession("s" + i, "m", "high");
    s.draft = "draft-" + i;
    s.messages = [
      {
        id: "reply-" + i,
        role: "assistant",
        content: "正文🙂" + i + "x".repeat(20000),
        timestamp: i,
        status: "completed",
      },
    ];
    repo.saveSession(s);
  }
  await repo.flush();
  return { repo, root, context };
}
test("transcript LRU caps count, retains recent/pinned data and reloads originals", async (t) => {
  const { repo } = await fixture(t);
  repo.getSession("s0");
  await repo.trimTranscriptCache((id) => id !== "s5", {
    maxSessions: 2,
    maxBytes: 1000000,
  });
  assert.deepEqual([...repo.loaded].sort(), ["s0", "s5"]);
  assert.equal(repo.getAllSessions().length, 6);
  for (const s of repo.getAllSessions())
    assert.equal(s.draft, "draft-" + s.id.slice(1));
  const restored = await repo.getSessionAsync("s1");
  assert.equal(restored.messages[0].content, "正文🙂1" + "x".repeat(20000));
  await repo.trimTranscriptCache((id) => id !== "s5", {
    maxSessions: 2,
    maxBytes: 1000000,
  });
  assert.deepEqual([...repo.loaded].sort(), ["s1", "s5"]);
});
test("byte budget evicts below count limit but reports protected overage truthfully", async (t) => {
  const { repo } = await fixture(t);
  await repo.trimTranscriptCache((id) => id !== "s5", {
    maxSessions: 100,
    maxBytes: 1000,
  });
  assert.deepEqual([...repo.loaded], ["s5"]);
  assert.equal(repo.cacheStats.transcripts.overBudget, true);
  assert(repo.cacheStats.transcripts.estimatedBytes > 1000);
  await repo.trimTranscriptCache(() => true, {
    maxSessions: 100,
    maxBytes: 1000,
  });
  assert.equal(repo.cacheStats.transcripts.estimatedBytes, 0);
  assert.equal(repo.cacheStats.transcripts.overBudget, false);
});
test("selection becoming protected while trim waits for disk prevents late eviction", async (t) => {
  const { repo } = await fixture(t);
  let unblock, started;
  const gate = new Promise((r) => (unblock = r)),
    start = new Promise((r) => (started = r));
  const atomic = repo.atomic.bind(repo);
  repo.atomic = async (file, raw) => {
    started();
    await gate;
    return atomic(file, raw);
  };
  const s = repo.getSession("s0");
  s.messages[0].content = "not yet durable";
  repo.saveSession(s);
  await start;
  let protectedId = "s5";
  const trim = repo.trimTranscriptCache((id) => id !== protectedId, {
    maxSessions: 0,
    maxBytes: 0,
  });
  protectedId = "s0";
  unblock();
  await trim;
  assert.equal(repo.loaded.has("s0"), true);
  assert.equal(s.messages[0].content, "not yet durable");
  assert.equal(repo.cacheStats.transcripts.overBudget, true);
});
test("storage failure retains source cache and retry enables safe budget eviction", async (t) => {
  const { repo } = await fixture(t);
  const s = repo.getSession("s0");
  s.messages[0].content = "must survive";
  const atomic = repo.atomic.bind(repo);
  repo.atomic = async () => {
    throw new Error("disk full");
  };
  repo.saveSession(s);
  await assert.rejects(
    repo.trimTranscriptCache(() => true, { maxSessions: 0, maxBytes: 0 }),
    /disk full/,
  );
  assert.equal(s.messages[0].content, "must survive");
  assert(repo.loaded.has(s.id));
  await repo.trimTranscriptCache(() => true, { maxSessions: 0, maxBytes: 0 });
  assert(
    repo.loaded.has(s.id),
    "failed session remains pinned after error was consumed",
  );
  repo.atomic = atomic;
  repo.saveSession(s);
  await repo.flush();
  await repo.trimTranscriptCache(() => true, { maxSessions: 0, maxBytes: 0 });
  assert.equal(repo.loaded.size, 0);
  const restored = await repo.getSessionAsync(s.id);
  assert.equal(restored.messages[0].content, "must survive");
});
test("estimator handles cyclic parameter objects and unknown lookups create no recency entries", async (t) => {
  const { repo } = await fixture(t);
  const cycle = { text: "x" };
  cycle.self = cycle;
  assert(
    transcriptBytes({ messages: [{ content: "abc", parameters: cycle }] }, [
      "filename",
    ]) >= 22,
  );
  const size = repo.cacheRecency.size;
  for (let i = 0; i < 100; i++)
    assert.equal(await repo.getSessionAsync("missing-" + i), undefined);
  assert.equal(repo.cacheRecency.size, size);
  await assert.rejects(
    async () =>
      repo.trimTranscriptCache(() => true, { maxSessions: -1, maxBytes: 2 }),
    /Invalid/,
  );
});
test("concurrent trim uses latest static guard and budget while waiting for disk", async (t) => {
  const { repo } = await fixture(t);
  let unblock, started;
  const gate = new Promise(r => unblock = r);
  const start = new Promise(r => started = r);
  const atomic = repo.atomic.bind(repo);
  repo.atomic = async (file, raw) => {started(); await gate; return atomic(file, raw);};
  const s = repo.getSession("s0");
  s.messages[0].content = "newly selected source";
  repo.saveSession(s);
  await start;
  const first = repo.trimTranscriptCache(() => true, {maxSessions: 6, maxBytes: 1000000});
  const latest = repo.trimTranscriptCache(id => id !== "s0", {maxSessions: 0, maxBytes: 0});
  assert.equal(first, latest, "coalesced callers await same completed trim");
  unblock();
  await latest;
  assert.deepEqual([...repo.loaded], ["s0"]);
  assert.equal(s.messages[0].content, "newly selected source");
  assert.equal(repo.cacheStats.transcripts.maxSessions, 0);
  assert.equal(repo.cacheStats.transcripts.overBudget, true);
});
