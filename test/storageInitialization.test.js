const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { ConversationRepository } = require("../out/conversation/repository");
const hash = (id) => createHash("sha256").update(id).digest("hex");
const session = (id, messages = []) => ({
  id,
  title: id,
  model: "m",
  effort: "high",
  planMode: true,
  totalTokens: 0,
  updatedAt: 1,
  messages,
});
const context = (dir, global = []) => ({
  globalStorageUri: { fsPath: dir },
  globalState: {
    get: (key, fallback) =>
      key === "antigravity.sessions.v1" ? global : fallback,
    update: async () => {},
  },
});

for (const operation of ['writeFile', 'rename']) test(`migration marker ${operation} failure cleans only its temporary record and retry preserves migrated messages`, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-marker-fault-'));
  const root = path.join(tmp, 'conversations-v3');
  const originals = [session('marker-retry', [{role: 'assistant', content: 'original 中文🙂', status: 'running'}])];
  const original = fs.promises[operation];
  let attempted;
  try {
    fs.promises[operation] = async function(file, ...args) {
      if (typeof file === 'string' && path.dirname(file) === root && path.basename(file).startsWith('migration.json.') && file.endsWith('.tmp')) {
        attempted = file;
        if (operation === 'writeFile') await original.call(this, file, 'partial uncommitted marker', {mode: 0o600});
        const error = new Error('injected migration marker failure');
        error.code = operation === 'writeFile' ? 'ENOSPC' : 'EIO';
        throw error;
      }
      return original.call(this, file, ...args);
    };
    await assert.rejects(ConversationRepository.open(context(tmp, originals)), /migration marker failure/);
  } finally {fs.promises[operation] = original;}
  try {
    assert(attempted, 'must hit the real migration completion marker');
    assert.equal(fs.existsSync(path.join(root, 'migration.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.migration-lock')), false);
    assert.equal(fs.existsSync(attempted), false, 'uncommitted marker must be cleaned after I/O failure');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'legacy-backup/globalState.json')))[0].messages[0].content, originals[0].messages[0].content);
    const restored = await ConversationRepository.open(context(tmp, originals));
    const messages = (await restored.getSessionAsync('marker-retry')).messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'original 中文🙂');
    assert.equal(messages[0].status, 'interrupted');
    assert.equal(messages[0].id, 'migrated-' + hash('marker-retry:0'));
    assert(fs.existsSync(path.join(root, 'migration.json')));
  } finally {fs.rmSync(tmp, {recursive: true, force: true});}
});

test("large startup uses a short-lived metadata worker without blocking Host FS calls; corrupt originals remain available", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-metadata-worker-"));
  const root = path.join(tmp, "conversations-v3");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "migration.json"), '{"version":3}');
  for (let index = 0; index < 501; index++) {
    const record = session("worker-" + index);
    const folder = path.join(root, hash(record.id));
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "session.json"), index === 500 ? "broken JSON" : JSON.stringify(record));
  }
  const methods = ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "existsSync", "statSync"];
  const saved = methods.map(name => [name, fs[name]]);
  try {
    for (const name of methods) fs[name] = () => {throw new Error("Host synchronous metadata access");};
    const repository = await ConversationRepository.open(context(tmp));
    assert.equal(repository.getAllSessions().length, 500);
  } finally { for (const [name, method] of saved) fs[name] = method; }
  try {
    assert.equal(fs.readFileSync(path.join(root, hash("worker-500"), "session.json"), "utf8"), "broken JSON");
    assert(fs.readdirSync(path.join(root, "quarantine")).length >= 1);
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test("production asynchronous initialization migrates without synchronous FS, preserves newer records and incomplete originals", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-initialize-"));
  const root = path.join(tmp, "conversations-v3");
  const existing = session("existing");
  existing.title = "newer title";
  fs.mkdirSync(path.join(root, hash(existing.id)), { recursive: true });
  fs.writeFileSync(
    path.join(root, hash(existing.id), "session.json"),
    JSON.stringify(existing),
  );
  const partial = path.join(root, hash("partial"));
  fs.mkdirSync(path.join(partial, "messages"), { recursive: true });
  fs.writeFileSync(
    path.join(partial, "messages", "original.json"),
    "original incomplete migration",
  );
  const records = [
    session("existing"),
    session("partial", [
      { role: "assistant", content: "恢复内容🙂", status: "running" },
    ]),
    session("legacy", [{ role: "user", content: "legacy", status: "sent" }]),
  ];
  const methods = [
    "readFileSync",
    "writeFileSync",
    "mkdirSync",
    "readdirSync",
    "existsSync",
    "statSync",
    "cpSync",
    "rmSync",
    "renameSync",
  ];
  const saved = methods.map((name) => [name, fs[name]]);
  let repository;
  try {
    for (const name of methods)
      fs[name] = () => {
        throw new Error("synchronous initialization: " + name);
      };
    repository = await ConversationRepository.open(context(tmp, records));
    assert.equal(repository.getAllSessions().length, 3);
    assert.equal(
      repository.getAllSessions().find((record) => record.id === "existing")
        .title,
      "newer title",
    );
    const restored = await repository.getSessionAsync("partial");
    assert.equal(restored.planMode, true);
    assert.equal(restored.messages[0].status, "interrupted");
    assert.equal(restored.messages[0].content, "恢复内容🙂");
    assert.equal(restored.messages[0].id, "migrated-" + hash("partial:0"));
  } finally {
    for (const [name, method] of saved) fs[name] = method;
  }
  try {
    const preserved = path.join(
      root,
      "quarantine",
      "incomplete-" + hash("partial"),
      "messages",
      "original.json",
    );
    assert.equal(
      fs.readFileSync(preserved, "utf8"),
      "original incomplete migration",
    );
    assert(fs.existsSync(path.join(root, "legacy-backup", "globalState.json")));
    const restored = await ConversationRepository.open(context(tmp, records));
    assert.equal(
      (await restored.getSessionAsync("partial")).messages[0].id,
      (await repository.getSessionAsync("partial")).messages[0].id,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("concurrent asynchronous startups serialize migration; a stale process identity is archived safely", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-migration-lock-"));
  const root = path.join(tmp, "conversations-v3");
  const token = randomUUID();
  fs.mkdirSync(path.join(root, ".migration-lock"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".migration-lock", "owner.json"),
    JSON.stringify({ pid: process.pid, token, identity: "previous-process:0" }),
  );
  const records = [
    session(
      "source",
      Array.from({ length: 100 }, (_, index) => ({
        role: "assistant",
        content: "message " + index,
        status: "completed",
      })),
    ),
  ];
  try {
    const [first, second] = await Promise.all([
      ConversationRepository.open(context(tmp, records)),
      ConversationRepository.open(context(tmp, records)),
    ]);
    assert.equal(first.getAllSessions().length, 1);
    assert.equal(second.getAllSessions().length, 1);
    assert.equal((await first.getSessionAsync("source")).messages.length, 30);
    assert.equal((await second.getSessionAsync("source")).messages.length, 30);
    assert(
      fs.existsSync(path.join(root, ".migration-stale-" + token, "owner.json")),
    );
    assert(!fs.existsSync(path.join(root, ".migration-lock")));
    assert.equal(
      fs.readdirSync(path.join(root, hash("source"), "messages")).length,
      100,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("migration I/O failure keeps originals and leaves no completion marker; retry retains stable IDs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-migration-retry-"));
  const root = path.join(tmp, "conversations-v3");
  const records = [
    session("retry", [
      { role: "assistant", content: "preserved", status: "completed" },
    ]),
  ];
  const rename = fs.promises.rename;
  try {
    fs.promises.rename = async (from, to) => {
      if (path.basename(from).startsWith(".migration-staging-")) {
        const error = new Error("simulated disk failure");
        error.code = "EIO";
        throw error;
      }
      return rename(from, to);
    };
    await assert.rejects(
      ConversationRepository.open(context(tmp, records)),
      /simulated disk failure/,
    );
  } finally {
    fs.promises.rename = rename;
  }
  try {
    assert(!fs.existsSync(path.join(root, "migration.json")));
    assert(!fs.existsSync(path.join(root, ".migration-lock")));
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(root, "legacy-backup", "globalState.json")),
      )[0].messages[0].content,
      "preserved",
    );
    const restored = await ConversationRepository.open(context(tmp, records));
    assert.equal(
      (await restored.getSessionAsync("retry")).messages[0].id,
      "migrated-" + hash("retry:0"),
    );
    assert(fs.existsSync(path.join(root, "migration.json")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
