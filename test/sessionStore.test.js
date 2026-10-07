const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { SessionStore } = require("../out/core/sessionStore");
Module._load = originalLoad;

function context(storage, state) {
  return {
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, value) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
  };
}

test("slow checkpoint writes coalesce latest bodies and tool originals without losing dirty messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-checkpoint-coalesce-"));
  const store = new SessionStore(context(root, new Map()), true, {highBytes: 4096, lowBytes: 1024});
  const pressure = [];
  store.on("storagePressure", paused => pressure.push(paused));
  const session = store.createSession("slow", "m", "high");
  session.messages = [{id: "a", role: "assistant", content: "first", status: "running", toolCalls: [{stepIndex: 1, name: "tool", state: "ACTIVE", output: "first original"}]}];
  store.saveSession(session);
  await store.flush();
  const atomic = store.atomic.bind(store);
  let release, arrived;
  const gate = new Promise(resolve => release = resolve);
  const started = new Promise(resolve => arrived = resolve);
  let paused = false;
  const writes = [];
  try {
    store.atomic = async (file, body) => {
      writes.push({file, body});
      if (!paused) {paused = true;arrived();await gate;}
      return atomic(file, body);
    };
    session.messages[0].content = "in-flight";
    store.saveSession(session, ["a"]);
    await started;
    session.messages.push({id: "b", role: "user", content: "also retain", timestamp: 2});
    store.saveSession(session, ["b"]);
    for (let revision = 0; revision < 100; revision++) {
      session.messages[0].content = "revision " + revision;
      session.messages[0].toolCalls[0].output = "原文🙂".repeat(10000) + revision;
      store.saveSession(session, ["a"]);
    }
    assert.equal(store.checkpointWrites.size, 1);
    const batch = store.checkpointWrites.get(session.id);
    assert.equal(batch.messages.size, 2);
    assert.equal(batch.tools.size, 1);
    assert.equal(batch.trims.size, 1);
    assert(store.writeQueueStats.paused);
    assert(store.writeQueueStats.estimatedBytes > 4096);
    release();
    await store.flush();
    assert.equal(writes.filter(write => write.file.includes("/messages/")).length, 3, "in-flight a plus latest a and distinct b");
    assert.equal(writes.filter(write => write.file.includes("/tools/")).length, 1);
    const restored = new SessionStore(context(root, new Map())).getSession(session.id);
    assert.deepEqual(restored.messages.map(message => message.content), ["revision 99", "also retain"]);
    const page = await store.toolOutputAsync(session.id, "a", 1);
    assert(page.output.startsWith("原文🙂"));
    const toolFile = writes.find(write => write.file.includes("/tools/")).file;
    assert.equal(await fs.readFile(toolFile, "utf8"), "原文🙂".repeat(10000) + "99");
    assert.equal(store.checkpointWrites.size, 0);
    assert.equal(store.writeQueueStats.estimatedBytes, 0);
    assert.equal(store.writeQueueStats.batches, 0);
    assert.equal(store.writeQueueStats.paused, false);
    assert.deepEqual(pressure.slice(-2), [true, false]);
  } finally {
    release?.();
    store.atomic = atomic;
    await store.flush();
    await fs.rm(root, {recursive: true, force: true});
  }
});

test("deletion commits after directory rename; failed rename retains selection, draft and history for retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-delete-transaction-"));
  const state = new Map();
  const store = new SessionStore(context(root, state));
  const session = store.createSession("delete-retry", "model", "high");
  session.draft = "retained draft";
  session.planMode = true;
  session.messages = [{id: "answer", role: "assistant", content: "retained answer", status: "completed"}];
  store.setCurrentSessionId(session.id);
  store.saveSession(session);
  await store.flush();
  const rename = fs.rename;
  let release, arrived;
  const blocked = new Promise(resolve => release = resolve);
  const started = new Promise(resolve => arrived = resolve);
  try {
    fs.rename = async (from, to) => {
      if (path.basename(to).startsWith(".deleted-")) {
        arrived();
        await blocked;
        throw Object.assign(new Error("simulated delete permission failure"), {code: "EACCES"});
      }
      return rename(from, to);
    };
    const deletion = store.deleteSession(session.id);
    assert.equal(store.deleteSession(session.id), deletion, "duplicate deletion shares operation");
    const rejected = assert.rejects(deletion, /permission failure/);
    await started;
    assert.equal(store.getSession(session.id), session);
    assert.throws(() => store.saveMetadata(session), /正在删除/);
    release();
    await rejected;
    assert.equal(store.getCurrentSessionId(), session.id);
    assert.equal(store.getSession(session.id).draft, "retained draft");
    assert.equal(store.getSession(session.id).planMode, true);
    assert.equal(new SessionStore(context(root, state)).getSession(session.id).messages[0].content, "retained answer");
  } finally { fs.rename = rename; }
  try {
    await store.deleteSession(session.id);
    assert.equal(store.getSession(session.id), undefined);
    assert.equal(store.getCurrentSessionId(), undefined);
    assert.equal(new SessionStore(context(root, state)).getSession(session.id), undefined);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("post-commit cleanup failure is explicit and a repeated deletion retries only that ID's tombstones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-delete-cleanup-"));
  const store = new SessionStore(context(root, new Map()));
  const session = store.createSession("cleanup", "m", "high");
  await store.flush();
  const warnings = [];
  store.on("cleanupWarning", warning => warnings.push(warning));
  const remove = fs.rm;
  try {
    fs.rm = async (file, options) => {
      if (path.basename(file).startsWith(".deleted-")) throw Object.assign(new Error("disk cleanup unavailable"), {code: "EACCES"});
      return remove(file, options);
    };
    await store.deleteSession(session.id);
    assert.equal(store.getSession(session.id), undefined);
    assert.equal(warnings.length, 1);
    assert(warnings[0].includes("会话已删除"));
    assert.equal(new SessionStore(context(root, new Map())).getSession(session.id), undefined);
    assert((await fs.readdir(path.join(root, "conversations-v3"))).some(file => file.startsWith(".deleted-")));
  } finally { fs.rm = remove; }
  try {
    await store.deleteSession(session.id);
    assert(!(await fs.readdir(path.join(root, "conversations-v3"))).some(file => file.startsWith(".deleted-")));
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("legacy state migrates to atomic per-session files and restores after host restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-session-test-"));
  const state = new Map();
  state.set("antigravity.sessions.v1", [
    {
      id: "legacy-id",
      title: "Old conversation",
      createdAt: 1,
      updatedAt: 2,
      model: "gemini-3.8-flash-high",
      effort: "high",
      totalTokens: 0,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "preserved",
          timestamp: 3,
          status: "running",
        },
      ],
    },
  ]);
  try {
    const initial = new SessionStore(context(root, state));
    await initial.flush();
    assert.equal(
      state.has("antigravity.sessions.v1"),
      true,
      "legacy rollback copy stays intact",
    );
    assert.ok(
      (await fs.readdir(path.join(root, "conversations-v3"))).some((name) =>
        name.endsWith(".json"),
      ),
    );

    const restored = new SessionStore(context(root, state));
    const session = restored.getSession("legacy-id");
    assert.equal(session.messages[0].content, "preserved");
    assert.equal(session.messages[0].status, "interrupted");
    assert.equal(restored.getCurrentSessionId(), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("session snapshots persist independently and deletion updates the index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-session-test-"));
  try {
    const store = new SessionStore(context(root, new Map()));
    store.createSession("one", "gemini-3.8-flash-high", "high");
    store.updateSessionMessages("one", [
      { id: "u", role: "user", content: "hello", timestamp: 1 },
      {
        id: "a",
        role: "assistant",
        content: "partial",
        timestamp: 2,
        status: "running",
      },
    ]);
    await store.flush();
    const messageDirectory = path.join(
      root,
      "conversations-v3",
      require("node:crypto").createHash("sha256").update("one").digest("hex"),
      "messages",
    );
    const files = (await fs.readdir(messageDirectory)).sort();
    const priorUserBytes = await fs.readFile(
      path.join(messageDirectory, files[0]),
      "utf8",
    );
    store.updateSessionMessages("one", [
      { id: "u", role: "user", content: "hello", timestamp: 1 },
      {
        id: "a",
        role: "assistant",
        content: "partial answer growing",
        timestamp: 2,
        status: "running",
      },
    ]);
    await store.flush();
    assert.equal(
      await fs.readFile(path.join(messageDirectory, files[0]), "utf8"),
      priorUserBytes,
      "checkpoint only rewrites the changed message file",
    );
    const restored = new SessionStore(context(root, new Map()));
    assert.equal(
      restored.getSession("one").messages[1].content,
      "partial answer growing",
    );
    restored.deleteSession("one");
    await restored.flush();
    assert.equal(
      new SessionStore(context(root, new Map())).getSession("one"),
      undefined,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
