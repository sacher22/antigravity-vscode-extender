const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseCommand,
  tokenize,
  commandRegistry,
} = require("../out/commands/registry");
const {
  NativeManagementAdapter,
  redact,
} = require("../out/adapters/nativeManagement");
const { AgyProcessManager } = require("../out/core/agyProcessManager");
const { nativeHistory, nativeHistoryAsync, nativeLogSizeAsync } = require("../out/conversation/nativeHistory");
test("native async log import matches public projection and rejects linked logs without sync I/O", async () => {
  const id = "async-parity-" + require("node:crypto").randomUUID();
  const directory = path.join(os.homedir(), ".gemini/antigravity-cli/brain", id, ".system_generated/logs");
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, "transcript.jsonl");
  const records = [
    {source: "USER", type: "USER_INPUT", status: "DONE", content: "中文", created_at: "2026-10-02T00:00:00Z"},
    {source: "MODEL", type: "THINKING", status: "DONE", content: "private"},
    {source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "answer🙂", created_at: "2026-10-02T00:00:01Z"},
  ];
  const body = records.map(record => JSON.stringify(record) + "\n").join("");
  fs.writeFileSync(file, body + '{"partial":');
  const expected = nativeHistory(id);
  const saved = new Map(["existsSync", "realpathSync", "statSync", "openSync", "readSync", "fstatSync"].map(name => [name, fs[name]]));
  try {
    for (const name of saved.keys()) fs[name] = () => {throw new Error("sync native I/O");};
    assert.deepEqual(await nativeHistoryAsync(id), expected);
    assert.equal(await nativeLogSizeAsync(id), Buffer.byteLength(body + '{"partial":'));
    const tail = await nativeHistoryAsync(id, expected.nextOffset);
    assert.equal(tail.messages.length, 0);
    assert.equal(tail.nextOffset, expected.nextOffset);
    await assert.rejects(nativeHistoryAsync(id, expected.nextOffset + 100), /页码/);
    await fs.promises.unlink(file);
    await fs.promises.symlink(__filename, file);
    await assert.rejects(nativeHistoryAsync(id), /日志路径/);
  } finally {
    for (const [name, method] of saved) fs[name] = method;
    fs.rmSync(path.join(os.homedir(), ".gemini/antigravity-cli/brain", id), {recursive: true, force: true});
  }
});
test("slash registry: aliases, quote/Windows paths, escaping and unknown commands", () => {
  assert.equal(parseCommand("/clear").spec.name, "new");
  assert.equal(parseCommand("/plugin list").spec.name, "plugins");
  assert.equal(parseCommand("ordinary /stop"), undefined);
  assert.equal(parseCommand("//plan"), undefined);
  assert.deepEqual(tokenize('"C:\\Users\\Foo Bar\\test.ts:5:2"'), [
    "C:\\Users\\Foo Bar\\test.ts:5:2",
  ]);
  assert.equal(parseCommand('/open "foo bar.py:7"').args[0], "foo bar.py:7");
  assert.throws(() => parseCommand("/does-not-exist"), /未知/);
  assert.throws(() => parseCommand('/open "unfinished'), /引号/);
  assert.equal(parseCommand("/stop").spec.busy, true);
  assert.equal(parseCommand("/plan").spec.busy, undefined);
  assert.equal(
    parseCommand("/my-skill", [{ name: "my-skill", route: "skill" }]).spec
      .route,
    "skill",
  );
});
test("native launch arguments preserve agent, schema, sandbox and directories without shell interpolation", () => {
  const manager = new AgyProcessManager();
  const args = manager.buildArgs({
    cliPath: "agy",
    cwd: "/project",
    model: "custom-model",
    effort: "max",
    agent: "research",
    sandbox: true,
    schemaPath: "/project/schema file.json",
    additionalDirectories: ["/one", "/two"],
  });
  for (const flag of [
    "--agent",
    "--sandbox",
    "--json-schema",
    "--add-dir",
    "--effort",
  ])
    assert(args.includes(flag));
  assert.equal(
    args[args.indexOf("--json-schema") + 1],
    "/project/schema file.json",
  );
  assert.equal(args[args.indexOf("--effort") + 1], "max");
});
test("native management caches read-only calls and rejects unsupported subprocess commands", async () => {
  const a = new NativeManagementAdapter(),
    cli = path.join(__dirname, "fixtures/fake-agy.js");
  assert.match(await a.run(cli, __dirname, ["models"], true), /3.6-flash-low/);
  assert.equal(
    await a.run(cli, __dirname, ["models"], true),
    await a.run(cli, __dirname, ["models"], true),
  );
  await assert.rejects(a.run(cli, __dirname, ["install"]), /不支持/);
  assert(
    !redact("API_KEY=secret\nAuthorization: Bearer abc\nnormal").includes(
      "secret",
    ),
  );
  assert(
    !redact("API_KEY=secret\nAuthorization: Bearer abc\nnormal").includes(
      "abc",
    ),
  );
});
test("custom skills discovery only indexes valid directory names with SKILL.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-"));
  try {
    const skill = path.join(root, ".agents/skills/probe");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "name: probe");
    fs.mkdirSync(path.join(root, ".git"));
    assert(
      new NativeManagementAdapter()
        .skills(root)
        .some((s) => s.name === "probe"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("native history projects only visible verified message types, resumes by byte offset, rejects symlinks", () => {
  const id = "parity-test-" + require("node:crypto").randomUUID();
  const directory = path.join(
    os.homedir(),
    ".gemini/antigravity-cli/brain",
    id,
    ".system_generated/logs",
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "transcript.jsonl");
  try {
    const records = [
      {
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "visible user",
      },
      {
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "visible answer",
        thinking: "hidden secret",
      },
      {
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        content: "private generic",
      },
      {
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content: "private system",
      },
    ];
    fs.writeFileSync(
      file,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const page = nativeHistory(id);
    assert.equal(page.messages.length, 2);
    assert(!JSON.stringify(page).includes("hidden secret"));
    assert(!JSON.stringify(page).includes("private generic"));
    assert.equal(nativeHistory(id, page.nextOffset).messages.length, 0);
    fs.appendFileSync(
      file,
      JSON.stringify({ ...records[1], content: "next public answer" }) + "\n",
    );
    assert.equal(
      nativeHistory(id, page.nextOffset).messages[0].content,
      "next public answer",
    );
    const other = path.join(os.tmpdir(), "agy-other-" + id);
    fs.writeFileSync(other, "private");
    fs.unlinkSync(file);
    fs.symlinkSync(other, file);
    assert.throws(() => nativeHistory(id), /日志路径/);
    fs.unlinkSync(other);
  } finally {
    fs.rmSync(path.join(directory, "../.."), { recursive: true, force: true });
  }
});

test("handoff refuses busy turns, preserves native configuration/ID and imports public terminal replies", async () => {
  const { ConversationController } = require("../out/conversation/controller");
  const { ConversationRepository } = require("../out/conversation/repository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-"));
  const values = new Map();
  const state = {
    get: (k, d) => (values.has(k) ? values.get(k) : d),
    update: async (k, v) => values.set(k, v),
  };
  const repository = new ConversationRepository({
    globalStorageUri: { fsPath: directory },
    globalState: state,
    workspaceState: state,
  });
  let terminal;
  const env = {
    config: () => ({
      cliPath: path.join(__dirname, "fixtures/fake-agy.js"),
      defaultModel: "custom-model",
      reasoningEffort: "max",
      dangerouslySkipPermissions: false,
      autoScroll: true,
    }),
    workspace: () => ({ root: directory, directories: [directory] }),
    setPermissions: async () => {},
    log() {},
    terminal: (cli, cwd, args, closed) =>
      (terminal = { cli, cwd, args, closed }),
  };
  const c = new ConversationController(env, repository);
  let logRoot;
  try {
    const s = c.prepareOrSwitchSessionUI();
    fs.writeFileSync(
      path.join(directory, "schema file.json"),
      JSON.stringify({ type: "object" }),
    );
    await c.setExecutionOptions({
      customAgent: "research-agent",
      sandbox: true,
      schemaPath: path.join(directory, "schema file.json"),
      extraDirectories: ["/tmp"],
    });
    await c.sendMessage("hang");
    await assert.rejects(c.openNativeCli(), /正在运行/);
    assert(c.processing);
    await c.abortTurn();
    const id = s.cliConversationId;
    await c.openNativeCli();
    assert.equal(
      terminal.args[terminal.args.indexOf("--conversation") + 1],
      id,
    );
    assert.equal(terminal.args[terminal.args.indexOf("--effort") + 1], "max");
    assert(terminal.args.includes("/tmp"));
    assert(terminal.args.includes("--sandbox"));
    assert(terminal.args.includes("research-agent"));
    assert(terminal.args.includes(path.join(directory, "schema file.json")));
    logRoot = path.join(os.homedir(), ".gemini/antigravity-cli/brain", id);
    const logs = path.join(logRoot, ".system_generated/logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "transcript.jsonl"),
      JSON.stringify({
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "TERMINAL_PUBLIC_REPLY",
      }) + "\n",
    );
    terminal.closed();
    for (
      let i = 0;
      i < 100 && !s.messages.some((m) => m.content === "TERMINAL_PUBLIC_REPLY");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert(s.messages.some((m) => m.content === "TERMINAL_PUBLIC_REPLY"));
    assert.notEqual(c.currentSessionMeta.id, s.id);
  } finally {
    await c.dispose();
    if (logRoot) fs.rmSync(logRoot, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("file links support inline/Markdown targets and do not backtrack quadratically on 100k text", () => {
  const { JSDOM } = require("jsdom");
  const { linkFileReferences } = require("../out/webview/fileLinks");
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { document: global.document, NodeFilter: global.NodeFilter };
  global.document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  try {
    const root = dom.window.document.querySelector("#root");
    root.innerHTML =
      '<p><code>/tmp/folder with space/test.py:5:2</code> docs/README.md#L5C3 https://example.com/docs.html</p><pre><code>/tmp/do-not-link.py</code></pre><a data-file-reference="file:///tmp/a.txt">file</a>';
    linkFileReferences(root);
    assert.equal(root.querySelectorAll("a").length, 3);
    assert(!root.querySelector("pre a"));
    assert.equal(
      root.querySelector("a").getAttribute("href"),
      "/tmp/folder with space/test.py:5:2",
    );
    root.textContent = "x".repeat(100000);
    const start = performance.now();
    linkFileReferences(root);
    assert(performance.now() - start < 1000);
    assert.equal(root.textContent.length, 100000);
  } finally {
    global.document = previous.document;
    global.NodeFilter = previous.NodeFilter;
    dom.window.close();
  }
});

test("schema validates single final JSON, rejects concatenated documents/schema mismatches and supports drafts", () => {
  const { schemaValidator } = require("../out/core/schemaValidation");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-schema-")),
    file = path.join(dir, "schema.json");
  try {
    for (const dialect of [
      undefined,
      "https://json-schema.org/draft/2020-12/schema",
      "https://json-schema.org/draft/2019-09/schema",
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          $schema: dialect,
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        }),
      );
      const validate = schemaValidator(file);
      assert.deepEqual(validate('{"ok":true}'), { ok: true });
      assert.throws(() => validate('{"ok":true}\n{"ok":false}'), /单个有效/);
      assert.throws(() => validate('{"ok":"yes"}'), /不符合/);
      assert.throws(() => validate('{"ok":true,"secret":"extra"}'), /不符合/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("safe command draft policy excludes native credentials, management, skills and malformed commands", () => {
  const {persistentDraft} = require("../out/commands/registry");
  for (const text of ["普通草稿", "//plan", "/plan 设计方案", "/effort incorrect", '/open "空 格.ts:3"'])
    assert.equal(persistentDraft(text), text);
  for (const text of ["/mcp add key-secret", "/plugin install key-secret", "/logout key-secret", "/cli", "/skill private key-secret", "/unknown key-secret", '/open "unfinished', "/new", "/stop"])
    assert.equal(persistentDraft(text), "");
});
test("command metadata covers every built-in, shares aliases and validates before side effects", () => {
  const {validateCommand, commandDescription} = require("../out/commands/registry");
  for (const spec of commandRegistry) {
    assert(spec.arguments, spec.name);
    assert(spec.draftPolicy, spec.name);
    assert(spec.capability, spec.name);
    assert(Array.isArray(spec.effects), spec.name);
    assert(commandDescription(spec).includes(spec.busy ? "运行中可用" : "需当前对话空闲"));
    for (const alias of spec.aliases || []) assert.equal(parseCommand('/' + alias).spec, spec);
  }
  const check = text => validateCommand(parseCommand(text), {busy: false, plan: false});
  for (const text of ["/help", "/model refresh", "/effort high", "/copy loaded", "/context selection", "/mcp enable abc-1", "/plugin disable @scope", "/plugin validate", '/open "空 格.ts"', "/plugin install name", "/parallel do this"])
    assert.doesNotThrow(() => check(text), text);
  for (const text of ["/help extra", "/model one two", "/effort invalid", "/copy last extra", "/context invalid", "/mcp add secret key", "/mcp enable", "/mcp enable ../x", "/plugin enable --all", "/plugin install --token=secret", "/sandbox maybe", "/skills unexpected", "/cli extra", "/parallel"])
    assert.throws(() => check(text), /用法/, text);
  assert.throws(() => validateCommand(parseCommand("/model"), {busy: true, plan: false}), /任务未被停止/);
  assert.doesNotThrow(() => validateCommand(parseCommand("/new"), {busy: true, plan: false}));
  assert.throws(() => validateCommand(parseCommand("/skill example"), {busy: false, plan: true}), /Plan 不执行技能/);
});
test("query cache invalidation fences late output and binary replacement invalidates warm results", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-query-identity-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const cli = path.join(root, "cli.cjs");
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs=require('fs');
const n=fs.existsSync('count')?Number(fs.readFileSync('count','utf8'))+1:1;
fs.writeFileSync('count',String(n));
if(n===1){fs.writeFileSync('ready','1');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('model-'+n);}},10);}else console.log('model-'+n);
`, {mode: 0o700});
  const adapter = new NativeManagementAdapter();
  const first = adapter.run(cli, root, ['models'], true);
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(root, 'ready'))) {
      if (Date.now() > deadline) throw new Error('query fixture did not start');
      await new Promise(r => setTimeout(r, 5));
    }
    adapter.clear();
    assert.equal(await adapter.run(cli, root, ['models'], true), 'model-2');
    fs.writeFileSync(path.join(root, 'release'), '1');
    assert.equal(await first, 'model-1');
    assert.equal(await adapter.run(cli, root, ['models'], true), 'model-2');
    assert.equal(fs.readFileSync(path.join(root, 'count'), 'utf8'), '2');
    assert.equal(adapter.cacheStats.queries.entries, 1);
    fs.writeFileSync(cli, "#!/usr/bin/env node\nif(process.argv[2]==='mcp')process.exit(1);console.log('replacement-binary');\n", {mode: 0o700});
    assert.equal(await adapter.run(cli, root, ['models'], true), 'replacement-binary');
    await assert.rejects(adapter.run(cli, root, ['mcp', 'disable', 'example']), /失败/);
    assert.equal(adapter.cacheStats.queries.entries, 0, 'failed mutation invalidates possibly stale queries');
    adapter.clear(); assert.equal(adapter.cacheStats.queries.entries, 0);
    assert.equal(adapter.cacheStats.skills.entries, 0);
  } finally {fs.writeFileSync(path.join(root, 'release'), '1'); await first.catch(() => {});}
});

test('native close keeps execution ownership through delayed persistence and duplicate close imports once', async () => {
  const {ConversationController} = require('../out/conversation/controller');
  const {ConversationRepository} = require('../out/conversation/repository');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agy-native-close-'));
  const values=new Map(),state={get:(k,d)=>values.has(k)?values.get(k):d,update:async(k,v)=>values.set(k,v)};
  const repository=new ConversationRepository({globalStorageUri:{fsPath:directory},globalState:state,workspaceState:state});
  let terminal;
  const env={config:()=>({cliPath:path.join(__dirname,'fixtures/fake-agy.js'),defaultModel:'custom-model',reasoningEffort:'high',dangerouslySkipPermissions:false,autoScroll:true}),workspace:()=>({root:directory,directories:[directory]}),setPermissions:async()=>{},log(){},terminal:(_cli,_cwd,_args,closed)=>{terminal={closed};}};
  const c=new ConversationController(env,repository);
  const originalFlush=repository.flush.bind(repository);let allowFlush,flushStarted,logRoot;
  try {
    const session=c.prepareOrSwitchSessionUI();
    await c.openNativeCli();
    const native=session.cliConversationId;
    assert(native);
    logRoot=path.join(os.homedir(),'.gemini/antigravity-cli/brain',native);
    const logs=path.join(logRoot,'.system_generated/logs');fs.mkdirSync(logs,{recursive:true});
    fs.writeFileSync(path.join(logs,'transcript.jsonl'),JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'DELAYED_NATIVE_REPLY'})+'\n');
    let count=0;
    const started=new Promise(resolve=>{flushStarted=resolve;});
    const gate=new Promise(resolve=>{allowFlush=resolve;});
    repository.flush=async()=>{count++;flushStarted();await gate;return originalFlush();};
    terminal.closed();terminal.closed();
    await started;
    assert.equal(repository.hasNativeExecution(native),true);
    const other=new ConversationRepository({globalStorageUri:{fsPath:directory},globalState:state,workspaceState:state});
    assert.throws(()=>other.acquire(native),/会话|执行|占用/);
    assert.equal(session.messages.filter(m=>m.content==='DELAYED_NATIVE_REPLY').length,1);
    assert.equal(count,1);
    allowFlush();
    for(let i=0;i<100&&repository.hasNativeExecution(native);i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(repository.hasNativeExecution(native),false);
    assert.equal(count,1);
    const claim=repository.acquire(native);claim();
  } finally {
    allowFlush?.();repository.flush=originalFlush;
    await c.dispose();
    if(logRoot)fs.rmSync(logRoot,{recursive:true,force:true});
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
