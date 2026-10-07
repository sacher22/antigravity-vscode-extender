const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJsonlPage, readJsonlPageAsync, publicLogRole } = require("../out/conversation/jsonl");
const { AgentRegistry } = require("../out/conversation/agents");
const { WebviewBridge } = require("../out/ui/webviewBridge");
const { RequestClient } = require("../out/webview/requestClient");
const { ViewStore } = require("../out/webview/state");
const { buildCliArguments } = require("../out/core/cliArguments");
const { executionProfile } = require("../out/conversation/executionProfile");
const { TurnDiagnostics } = require("../out/conversation/turnDiagnostics");
const { CodePreviews } = require("../out/ui/codePreviews");
const { codeBlocks } = require("../out/core/codeBlocks");
const { gitChanges } = require("../out/adapters/gitChanges");
const {
  appendContext,
  combineContext,
  contextItems,
} = require("../out/core/contextAttachments");

test("completion patches retain streamed body and tool identity; older turns cannot end a newer one", () => {
  const store = new ViewStore(() => {});
  const tool = { stepIndex: 8, name: "view_file", state: "DONE", output: "contents" };
  const message = { id: "reply", role: "assistant", content: "full text", blocks: [{stepIndex: 2, text: "full text"}], toolCalls: [tool], status: "running" };
  store.receive({ type: "initSession", session: { id: "session", messages: [] }, activeTurn: {state: {turnId: "turn", phase: "responding"}, message}, config: {} });
  store.receive({ type: "turnState", state: {turnId: "turn", phase: "completed"} });
  store.receive({ type: "turnComplete", messageId: "reply", turnId: "turn", result: {status: "SUCCESS"}, changes: {status: "completed", usage: {total_tokens: 42}}, sessionSummary: {updatedAt: 10, totalTokens: 42} });
  const completed = store.state.messages[0];
  assert.equal(completed.content, "full text");
  assert.equal(completed.blocks[0].text, "full text");
  assert.equal(completed.toolCalls[0], tool);
  assert.equal(completed.status, "completed");
  assert.equal(store.state.session.totalTokens, 42);
  store.receive({type: "turnState", state: {turnId: "next", phase: "connecting"}});
  store.receive({type: "turnComplete", messageId: "reply", turnId: "turn", result: {status: "SUCCESS"}, changes: {status: "failed"}});
  assert.equal(store.state.active.turnId, "next");
  assert.equal(store.state.messages[0].status, "completed");
});

test("snapshot reuse keeps unchanged tools while updating changed tool parameters", () => {
  const store = new ViewStore(() => {});
  const message = {id: "reply", role: "assistant", content: "body", toolCalls: [{stepIndex: 2, name: "tool", state: "DONE", parameters: {path: "a"}, output: "answer"}]};
  const snapshot = {type: "initSession", session: {id: "session", messages: [message]}, config: {}};
  store.receive(snapshot);
  const original = store.state.messages[0].toolCalls;
  store.receive(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(store.state.messages[0].toolCalls, original);
  const changed = JSON.parse(JSON.stringify(snapshot));
  changed.session.messages[0].toolCalls[0].parameters.path = "b";
  store.receive(changed);
  assert.notEqual(store.state.messages[0].toolCalls[0], original[0]);
  assert.equal(store.state.messages[0].toolCalls[0].parameters.path, "b");
});

test("context attachments retain metadata and UTF-8 byte counts; oversized additions preserve previous content", () => {
  const first = appendContext(undefined, {
    code: "中文",
    uri: "file:///a.ts",
    file: "/a.ts",
    version: 1,
    range: { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } },
  });
  assert.equal(first.items[0].bytes, 6);
  const second = appendContext(first, {
    code: "next",
    uri: "file:///b.ts",
    file: "/b.ts",
    version: 2,
  });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 2);
  assert(second.code.includes("/a.ts"));
  assert(second.code.includes("/b.ts"));
  assert.equal(second.bytes, Buffer.byteLength(second.code));
  assert.throws(
    () =>
      appendContext(second, {
        code: "x".repeat(1024 * 1024),
        uri: "file:///large.ts",
      }),
    /超过/,
  );
  assert.equal(second.items.length, 2);
  assert.equal(
    combineContext(contextItems(second).slice(1)).items[0].uri,
    "file:///b.ts",
  );
  assert.equal(combineContext([]), undefined);
  assert.equal(contextItems({ code: "legacy", file: "old" })[0].code, "legacy");
});

test("large Git diffs produce bounded previews and Git errors retain the real reason", async () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-diff-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    git("init");
    await assert.rejects(gitChanges(dir, true), /HEAD/);
    const file = path.join(dir, "large.txt");
    fs.writeFileSync(file, "original\n");
    git("add", "large.txt");
    git(
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "-m",
      "baseline",
    );
    fs.writeFileSync(file, "changed\n".repeat(100000));
    const output = await gitChanges(dir, true);
    assert(output.includes("截断"));
    assert(Buffer.byteLength(output) < 66000);
    await assert.rejects(gitChanges(path.join(dir, "missing")), /无法启动 Git/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preview tokens bind session message block and target; eviction and close release resources", () => {
  const released = [];
  const previews = new CodePreviews((p) => released.push(p.diffUri), 2);
  const base = {
    sessionId: "session",
    messageId: "message",
    blockIndex: 0,
    target: "file:///a/name.ts",
    version: 1,
    originalHash: "old",
    code: "new",
    diffUri: "diff:/first",
  };
  const a = previews.create(base);
  const b = previews.create({
    ...base,
    target: "file:///b/name.ts",
    diffUri: "diff:/second",
    blockIndex: 1,
  });
  assert.equal(
    previews.get(a, "session", "message", 0, "new").target,
    "file:///a/name.ts",
  );
  assert.equal(
    previews.get(b, "session", "message", 1, "new").target,
    "file:///b/name.ts",
  );
  assert.throws(() => previews.get(a, "other", "message", 0, "new"), /预览/);
  assert.throws(() => previews.get(a, "session", "message", 1, "new"), /预览/);
  previews.create({ ...base, diffUri: "diff:/third" });
  assert.throws(() => previews.get(a, "session", "message", 0, "new"), /预览/);
  previews.closeDocument("diff:/second");
  assert.throws(() => previews.get(b, "session", "message", 1, "new"), /预览/);
  previews.dispose();
  assert.deepEqual(released, ["diff:/first", "diff:/second", "diff:/third"]);
  assert.deepEqual(codeBlocks("```ts\none\n```\n```js\ntwo\n```"), [
    "one\n",
    "two\n",
  ]);
});

test("turn diagnostics use monotonic elapsed milestones and suppress repeated token events", () => {
  let now = 100;
  const logs = [];
  const timeline = new TurnDiagnostics(
    "turn",
    (m) => logs.push(JSON.parse(m)),
    () => now,
  );
  now = 130;
  timeline.mark("cli-ready");
  now = 150;
  timeline.mark("first-cli-text");
  for (let i = 0; i < 1000; i++) timeline.mark("first-cli-text");
  assert.equal(logs.length, 3);
  assert.deepEqual(
    logs.map((m) => m.elapsedMs),
    [0, 30, 50],
  );
});

test("native and stream launch options match except transport and Plan rejects Danger", () => {
  const options = {
    cliPath: "agy",
    cwd: "/project",
    model: "custom",
    effort: "high",
    agent: "research",
    sandbox: true,
    schemaPath: "/schema",
    additionalDirectories: ["/project", "/second"],
    conversationId: "conversation",
    dangerouslySkipPermissions: true,
  };
  assert.deepEqual(
    buildCliArguments(options).slice(4),
    buildCliArguments(options, false),
  );
  assert.throws(
    () => buildCliArguments({ ...options, isPlanMode: true }),
    /Plan/,
  );
});

test("execution profile freezes directories and fingerprints schema content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
  try {
    const schemaPath = path.join(dir, "schema.json");
    fs.writeFileSync(schemaPath, "{}");
    const options = {
      cliPath: "agy",
      cwd: dir,
      additionalDirectories: [dir],
      schemaPath,
    };
    const first = executionProfile("model", options);
    options.additionalDirectories.push("/late");
    assert.deepEqual(first.options.additionalDirectories, [dir]);
    assert(Object.isFrozen(first.options));
    fs.writeFileSync(schemaPath, '{"type":"string"}');
    const second = executionProfile("model", {
      ...options,
      additionalDirectories: [dir],
    });
    assert.notEqual(first.signature, second.signature);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("request timeout reports unknown result and sends no automatic duplicate", async () => {
  const sent = [];
  const client = new RequestClient(
    (m) => sent.push(m),
    () => "session",
    20,
  );
  await assert.rejects(client.request({ command: "newSession" }), /未确认/);
  assert.equal(sent.length, 1);
  assert.equal(client.pending.size, 0);
  client.receive({ type: "requestComplete", requestId: sent[0].requestId });
  client.dispose();
});

test("sequence gaps request one snapshot until restored", () => {
  let requests = 0;
  const store = new ViewStore(() => {
    requests++;
  });
  store.receive({
    type: "sessionList",
    sequence: 1,
    sessions: [],
    currentId: "",
  });
  store.receive({
    type: "sessionList",
    sequence: 3,
    sessions: [],
    currentId: "",
  });
  store.receive({
    type: "sessionList",
    sequence: 4,
    sessions: [],
    currentId: "",
  });
  assert.equal(requests, 1);
});

test("JSONL long UTF-8 record stays intact; incomplete tail never commits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jsonl-"));
  const file = path.join(dir, "log");
  const content = "中文".repeat(220000);
  const line = JSON.stringify({ content }) + "\n";
  fs.writeFileSync(file, line + '{"unfinished":');
  const fd = fs.openSync(file, "r");
  try {
    const page = readJsonlPage(fd, 0);
    assert.equal(JSON.parse(page.bytes.toString()).content, content);
    assert.equal(page.nextOffset, Buffer.byteLength(line));
    const tail = readJsonlPage(fd, page.nextOffset);
    assert.equal(tail.nextOffset, page.nextOffset);
    assert.equal(tail.bytes.length, 0);
    assert(tail.hasMore);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true });
  }
});

test("asynchronous JSONL preserves complete UTF-8 cursors without synchronous file calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jsonl-async-"));
  const file = path.join(dir, "log");
  const content = "中文🙂".repeat(220000);
  const line = JSON.stringify({content}) + "\n";
  fs.writeFileSync(file, line + '{"unfinished":');
  const handle = await fs.promises.open(file, "r");
  const original = new Map(["readSync", "fstatSync"].map(name => [name, fs[name]]));
  try {
    for (const name of original.keys()) fs[name] = () => {throw new Error("synchronous log I/O");};
    const page = await readJsonlPageAsync(handle, 0);
    assert.equal(JSON.parse(page.bytes.toString()).content, content);
    assert.equal(page.nextOffset, Buffer.byteLength(line));
    const tail = await readJsonlPageAsync(handle, page.nextOffset);
    assert.equal(tail.nextOffset, page.nextOffset);
    assert.equal(tail.bytes.length, 0);
    assert.equal(tail.hasMore, true);
    await assert.rejects(readJsonlPageAsync(handle, -1), /页码/);
    await assert.rejects(readJsonlPageAsync(handle, 0, 0), /页大小/);
  } finally {
    for (const [name, method] of original) fs[name] = method;
    await handle.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test("public log projection rejects unknown and private types", () => {
  for (const type of ["GENERIC", "THINKING", "SYSTEM_MESSAGE"])
    assert.equal(
      publicLogRole(
        { source: "MODEL", type, status: "DONE", content: "private" },
        true,
      ),
      undefined,
    );
  assert.equal(
    publicLogRole({
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "public",
    }),
    "assistant",
  );
});

test("agent debounce can reopen after cancellation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-watch-"));
  const logs = path.join(dir, "child", ".system_generated/logs");
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(file, "");
  let changes = 0;
  const registry = new AgentRegistry(
    [
      {
        id: "child",
        state: "unknown",
        logUri: require("node:url").pathToFileURL(file).href,
      },
    ],
    () => changes++,
    dir,
  );
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    registry.watch(true);
    for (let i = 0; i < 100 && !registry.watchers.size; i++) await delay(5);
    assert.equal(registry.watchers.size, 1);
    fs.appendFileSync(file, "first\n");
    await delay(30);
    assert(registry.timer);
    registry.watch(false);
    assert.equal(registry.timer, undefined);
    registry.watch(true);
    for (let i = 0; i < 100 && !registry.watchers.size; i++) await delay(5);
    assert.equal(registry.watchers.size, 1);
    fs.appendFileSync(file, "second\n");
    await delay(200);
    assert.equal(changes, 1);
  } finally {
    registry.dispose();
    fs.rmSync(dir, { recursive: true });
  }
});

test("duplicate request replays result without repeating mutation", async () => {
  let mutations = 0;
  const replies = [];
  const bridge = new WebviewBridge(
    async () => {
      mutations++;
    },
    (m) => replies.push(m),
    () => "session",
  );
  const request = {
    command: "newSession",
    requestId: "same",
    sessionId: "session",
  };
  await Promise.all([bridge.receive(request), bridge.receive(request)]);
  await bridge.receive(request);
  assert.equal(mutations, 1);
  assert.equal(replies.length, 3);
  assert.deepEqual(replies[0], replies[2]);
});


test("projected history total count updates without replacing unchanged rows; legacy lists remain compatible", () => {
  const store = new ViewStore(() => {});
  const sessions = [{id: "recent", title: "Recent", updatedAt: 1}];
  store.receive({type: "sessionList", currentId: "recent", sessions, totalCount: 10000});
  const rows = store.snapshot().sessions;
  assert.equal(store.snapshot().sessionTotalCount, 10000);
  store.receive({type: "sessionList", currentId: "recent", sessions: [{...sessions[0]}], totalCount: 10001});
  assert.equal(store.snapshot().sessions, rows);
  assert.equal(store.snapshot().sessionTotalCount, 10001);
  store.receive({type: "sessionList", currentId: "recent", sessions});
  assert.equal(store.snapshot().sessionTotalCount, 1);
});

test("typed cancellation round-trips through bridge/client and replay; cancellation text alone stays failure", async () => {
  const {OperationCancelledError}=require('../out/core/operationErrors');
  for(const cancellation of [true,false]){
    const sent=[],replies=[];let calls=0;
    const client=new RequestClient(message=>sent.push(message),()=>"session");
    const bridge=new WebviewBridge(async()=>{calls++;throw cancellation?new OperationCancelledError():new Error("操作已取消。");},message=>{replies.push(message);client.receive(message);},()=>"session");
    const request=client.request({command:"newSession"});
    const rejected=assert.rejects(request,error=>(error instanceof OperationCancelledError)===cancellation);
    await bridge.receive(sent[0]);await rejected;
    assert.equal(replies[0].cancelled,cancellation?true:undefined);
    await bridge.receive(sent[0]);assert.equal(calls,1);assert.equal(replies.length,2);assert.equal(replies[1].cancelled,replies[0].cancelled);
    client.dispose();
  }
});
