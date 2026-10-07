const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const Module = require("node:module");
const root = path.resolve(__dirname, "..");
const config = new Map([
  ["cliPath", path.join(__dirname, "fixtures/fake-agy.js")],
]);
const mock = {
  commands: { executeCommand: async () => {} },
  Range: class {},
  Position: class {constructor(line, character) {this.line = line; this.character = character;}},
  WorkspaceEdit: class {},
  Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }) },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (k, d) => (config.has(k) ? config.get(k) : d),
      update: async (k, v) => config.set(k, v),
    }),
  },
  ConfigurationTarget: { Global: 1 },
};
const original = Module._load;
Module._load = function (r, ...a) {
  return r === "vscode" ? mock : original.call(this, r, ...a);
};
const { ChatViewProvider } = require("../out/ui/chatViewProvider");
const { AgyService } = require("../out/services/agyService");
const { SessionStore } = require("../out/core/sessionStore");
Module._load = original;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f) {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > 4000) throw new Error("Timed out waiting for UI");
    await delay(5);
  }
}
async function harness(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ui-"));
  const values = new Map();
  const state = {
    get: (k, d) => (values.has(k) ? values.get(k) : d),
    update: async (k, v) => values.set(k, v),
  };
  const ctx = {
    globalStorageUri: { fsPath: tmp },
    globalState: state,
    workspaceState: state,
    subscriptions: [],
  };
  const repo = new SessionStore(ctx);
  const service = new AgyService(ctx, repo);
  const provider = new ChatViewProvider({ fsPath: root }, service, repo, options.diffProvider || {});
  const html = provider.getHtmlForWebview({
    cspSource: "test:",
    asWebviewUri: (u) => u.fsPath,
  });
  const dom = new JSDOM(
    html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""),
    {
      url: "https://test.local",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  dom.window.TextEncoder = TextEncoder;
  if (options.renderVisible) {
    const rect = () => ({top:0,bottom:500,left:0,right:500,width:500,height:500,x:0,y:0});
    dom.window.HTMLElement.prototype.getBoundingClientRect = rect;
    dom.window.Range.prototype.getBoundingClientRect = rect;
  }
  const sent = [], received = [];
  let receiver, apiAcquisitions = 0;
  dom.window.acquireVsCodeApi = () => {apiAcquisitions++;return ({
    getState: () => ({}),
    setState() {},
    postMessage: (d) => {
      sent.push(d);
      void receiver(d);
    },
  });};
  let visibilityChanged = () => {}, viewDisposed = () => {};
  const view = {
      webview: {
        options: {},
        html: "",
        asWebviewUri: (u) => u.fsPath,
        cspSource: "test:",
        onDidReceiveMessage: (cb) => {
          receiver = cb;
          return { dispose() {} };
        },
        postMessage: (m) => {
          received.push(m);
          dom.window.dispatchEvent(
            new dom.window.MessageEvent("message", {
              data: JSON.parse(JSON.stringify(m)),
            }),
          );
          return Promise.resolve(true);
        },
      },
      visible: true,
      onDidChangeVisibility: cb => {visibilityChanged = cb; return { dispose() {} };},
      onDidDispose: cb => {viewDisposed = cb;},
      show() {},
    };
  provider.resolveWebviewView(view, {}, {});
  dom.window.eval(fs.readFileSync(path.join(root, "media/chat.js"), "utf8"));
  await until(
    () =>
      dom.window.document.querySelector("#message-input") &&
      service.currentSessionMeta,
  );
  await delay(20);
  const doc = dom.window.document;
  function input(text) {
    const el = doc.querySelector("#message-input");
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, text);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function choose(id, value) {
    const el = doc.querySelector(id);
    el.value = value;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  }
  return {
    dom,
    apiAcquisitions: () => apiAcquisitions,
    doc,
    sent,
    received,
    view,
    receive: message => receiver(message),
    setVisible: value => {view.visible = value; visibilityChanged();},
    disposeView: () => viewDisposed(),
    service,
    repo,
    provider,
    input,
    choose,
    tmp,
    async close() {
      await service.dispose();
      dom.window.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
test("tool preview follows replacement output revisions without opening an extra CLI", async () => {
  const h = await harness();
  try {
    await h.service.sendMessage("hang");
    const runner = h.service.executionTarget();
    const emit = (output) =>
      runner.processManager.emit(
        "step_update",
        {
          step_index: 5,
          step_type: "tool",
          tool_name: "changing",
          state: "ACTIVE",
          tool_info: { output },
        },
        runner.processManager.currentGeneration,
        Date.now(),
      );
    emit("first output");
    await until(() =>
      h.doc
        .querySelector(".tool pre:last-of-type")
        ?.textContent.includes("first output"),
    );
    emit("replacement output");
    await until(() =>
      h.doc
        .querySelector(".tool pre:last-of-type")
        ?.textContent.includes("replacement output"),
    );
    assert(
      !h.doc
        .querySelector(".tool pre:last-of-type")
        .textContent.includes("first output"),
    );
    assert.equal(runner.turn.toolRevisions.get(5), 2);
    await h.service.abortTurn();
  } finally {
    await h.close();
  }
});

test("file picker attaches multiple URI snapshots and selection keeps exact range across history switch", async () => {
  const h = await harness();
  const original = {
    open: mock.workspace.openTextDocument,
    dialog: mock.window.showOpenDialog,
    editor: mock.window.activeTextEditor,
  };
  const uris = ["file:///one.ts", "file:///two.ts"].map((value) => ({
    fsPath: new URL(value).pathname,
    toString: () => value,
  }));
  mock.window.showOpenDialog = async (options) => {
    assert.equal(options.canSelectMany, true);
    return uris;
  };
  mock.workspace.openTextDocument = async (uri) => ({
    uri,
    version: 3,
    lineCount: 2,
    getText: () => uri.fsPath,
  });
  mock.window.activeTextEditor = {
    document: { uri: uris[0], version: 4, getText: () => "selection text" },
    selection: {
      isEmpty: false,
      start: { line: 4, character: 2 },
      end: { line: 5, character: 3 },
    },
  };
  try {
    const id = h.service.currentSessionMeta.id;
    await h.provider.handleWebviewMessage({
      command: "requestContext",
      contextType: "file",
    });
    await h.provider.handleWebviewMessage({
      command: "requestContext",
      contextType: "selection",
    });
    await until(() => h.doc.querySelectorAll(".attachment").length === 3);
    const items = h.service.currentSessionMeta.attachment.items;
    assert.equal(items[0].uri, "file:///one.ts");
    assert.equal(items[0].version, 3);
    assert.deepEqual(items[2].range, {
      start: { line: 4, character: 2 },
      end: { line: 5, character: 3 },
    });
    await h.service.newSession(true);
    assert.equal(h.service.currentSessionMeta.attachment, undefined);
    await h.service.switchSession(id);
    await until(() => h.doc.querySelectorAll(".attachment").length === 3);
    assert.equal(
      h.service.currentSessionMeta.attachment.items[2].code,
      "selection text",
    );
  } finally {
    mock.workspace.openTextDocument = original.open;
    mock.window.showOpenDialog = original.dialog;
    mock.window.activeTextEditor = original.editor;
    await h.close();
  }
});

test("multiple attachments persist independently, remove individually and send remaining context", async () => {
  const h = await harness();
  try {
    await h.provider.sendCodeContext("alpha", "/a.ts", 1, "A", {
      uri: "file:///a.ts",
      version: 1,
    });
    await h.provider.sendCodeContext("beta", "/b.ts", 1, "B", {
      uri: "file:///b.ts",
      version: 2,
    });
    await until(() => h.doc.querySelectorAll(".attachment").length === 2);
    const id = h.service.currentSessionMeta.id;
    assert.equal(h.service.currentSessionMeta.attachment.items.length, 2);
    h.doc.querySelectorAll(".attachment button")[0].click();
    await until(() => h.doc.querySelectorAll(".attachment").length === 1);
    await until(
      () => h.service.currentSessionMeta.attachment.items.length === 1,
    );
    h.input("use remaining context");
    await delay(20);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".assistant"));
    await until(() => !h.service.processing);
    const message = h.doc.querySelector(".assistant").textContent;
    assert(message.includes("beta"));
    assert(!message.includes("alpha"));
    assert.equal(h.service.currentSessionMeta.id, id);
  } finally {
    await h.close();
  }
});

test("preview apply checks original version and uses reviewed URI after active editor changes", async () => {
  const h = await harness({diffProvider: {setContent() {}, removeContent() {}}});
  const original = {
    file: mock.Uri.file,
    parse: mock.Uri.parse,
    editor: mock.window.activeTextEditor,
    open: mock.workspace.openTextDocument,
    apply: mock.workspace.applyEdit,
    commands: mock.commands,
    Range: mock.Range,
    WorkspaceEdit: mock.WorkspaceEdit,
  };
  const uri = (text) => ({
    fsPath: new URL(text).pathname,
    toString: () => text,
  });
  const target = uri("file:///project/a/name.ts");
  let text = "old";
  const doc = {
    uri: target,
    version: 1,
    getText: () => text,
    positionAt: (n) => n,
  };
  const applied = [];
  mock.Uri.file = p => uri("file://"+p);
  mock.Uri.parse = uri;
  mock.window.activeTextEditor = { document: doc };
  mock.workspace.openTextDocument = async () => doc;
  mock.workspace.applyEdit = async (edit) => {
    applied.push(edit.replacement);
    return true;
  };
  mock.commands = { executeCommand: async () => {} };
  mock.Range = class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  };
  mock.WorkspaceEdit = class {
    replace(uri, range, code) {
      this.replacement = { uri: uri.toString(), code };
    }
  };
  try {
    await h.service.sendMessage("```ts file=/project/a/name.ts\nnew\n```");
    await until(() => !h.service.processing);
    await delay(20);
    const buttons = h.doc
      .querySelector(".assistant .code-actions")
      .querySelectorAll("button");
    buttons[1].click();
    await until(() => !buttons[2].disabled);
    doc.version++;
    text = "external edit";
    buttons[2].click();
    await until(() =>
      h.doc.querySelector(".assistant .code-actions [role=alert]"),
    );
    assert.equal(applied.length, 0);
    assert(
      h.doc
        .querySelector(".assistant .code-actions")
        .textContent.includes("变化"),
    );
    await until(() => !buttons[1].disabled);
    buttons[1].click();
    await until(
      () => h.sent.filter((m) => m.command === "viewDiff").length === 2,
    );
    await delay(20);
    await until(() => !buttons[2].disabled);
    mock.window.activeTextEditor = {
      document: { uri: uri("file:///project/b/name.ts") },
    };
    buttons[2].click();
    await until(() => applied.length === 1);
    assert.deepEqual(applied[0], {
      uri: "file:///project/a/name.ts",
      code: "new\n",
    });
  } finally {
    mock.Uri.file = original.file;
    mock.Uri.parse = original.parse;
    mock.window.activeTextEditor = original.editor;
    mock.workspace.openTextDocument = original.open;
    mock.workspace.applyEdit = original.apply;
    mock.commands = original.commands;
    mock.Range = original.Range;
    mock.WorkspaceEdit = original.WorkspaceEdit;
    await h.close();
  }
});

test("unspecified code targets offer copy only and Mermaid has no file actions", async () => {
  const h=await harness();try {
    await h.service.sendMessage("```mermaid\ngraph TD;A-->B\n```\n```ts\nfirst\n```\n```js\nsecond\n```");
    await until(()=>!h.service.processing);await delay(20);
    const actions=h.doc.querySelectorAll('.assistant .code-actions');assert.equal(actions.length,2);
    for(const action of actions)assert.deepEqual([...action.querySelectorAll('button')].map(b=>b.textContent),['复制代码']);
    assert.equal(h.sent.filter(m=>m.command==='viewDiff').length,0);
  }finally{await h.close();}
});

test("slash keyboard completion supports arrows Tab Escape and never submits during IME", async () => {
  const h = await harness();
  try {
    await until(() => h.doc.querySelector("#message-input"));
    h.input("/");
    await delay(20);
    const input = h.doc.querySelector("#message-input");
    const key = (k) =>
      input.dispatchEvent(
        new h.dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }),
      );
    key("ArrowDown");
    await delay(10);
    const first = h.doc.querySelector(
      "[role=option][aria-selected=true] strong",
    ).textContent;
    key("Tab");
    await delay(10);
    assert.equal(input.value, first + " ");
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 0);
    h.input("/");
    await delay(10);
    key("Escape");
    await delay(10);
    assert.equal(h.doc.querySelectorAll("[role=option]").length, 0);
    h.input("/h");
    await delay(10);
    input.dispatchEvent(
      new h.dom.window.CompositionEvent("compositionstart", { bubbles: true }),
    );
    key("Tab");
    key("Enter");
    await delay(10);
    assert.equal(input.value, "/h");
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 0);
  } finally {
    await h.close();
  }
});

test("hidden view receives no sequenced streaming IPC and restores from snapshot", async () => {
  const h = await harness();
  try {
    const first = h.service.currentSessionMeta.id;
    h.provider.view.visible = false;
    await h.service.sendMessage("hidden reply");
    await until(() => !h.service.processing);
    assert.equal(h.doc.querySelectorAll(".assistant").length, 0);
    h.provider.view.visible = true;
    h.service.sendSnapshot();
    await until(() => h.doc.querySelector(".assistant"));
    assert(
      h.doc.querySelector(".assistant").textContent.includes("hidden reply"),
    );
    assert.equal(h.service.currentSessionMeta.id, first);
  } finally {
    await h.close();
  }
});

test("real React Webview → Provider → Controller → CLI: send, plus, history, mode and draft", async () => {
  const h = await harness();
  try {
    const first = h.service.currentSessionMeta.id;
    h.input("hello");
    await delay(5);
    h.doc.querySelector("#send-btn").click();
    await until(
      () =>
        h.doc.querySelector(".assistant")?.textContent.includes("hello") &&
        !h.service.processing,
    );
    assert.equal(h.service.currentSessionMeta.id, first);
    assert.match(h.service.currentSessionMeta.cliConversationId, /^fake-/);
    h.input("unsent draft");
    await delay(5);
    h.doc.querySelector("#new-session-btn").click();
    h.doc.querySelector("#new-session-btn").click();
    await until(() => h.service.currentSessionMeta.id !== first);
    await delay(25);
    const second = h.service.currentSessionMeta.id;
    assert.equal(h.doc.querySelectorAll(".message").length, 0);
    assert.equal(h.doc.querySelector("#message-input").value, "");
    assert.equal(h.sent.filter((m) => m.command === "newSession").length, 1);
    h.choose("#mode-select", "plan");
    await until(() => h.service.currentSessionMeta.planMode === true);
    await delay(20);
    assert.equal(
      h.sent.filter((m) => m.command === "togglePlanMode").length,
      1,
    );
    h.choose("#mode-select", "normal");
    await until(() => h.service.currentSessionMeta.planMode === false);
    h.choose("#session-select", first);
    await until(() => h.service.currentSessionMeta.id === first);
    await delay(20);
    assert.equal(h.doc.querySelector("#message-input").value, "unsent draft");
    assert.ok(h.doc.querySelector(".assistant").textContent.includes("hello"));
    h.doc.querySelector("#new-session-btn").click();
    await until(() => h.service.currentSessionMeta.id !== first);
    assert.notEqual(h.service.currentSessionMeta.id, second);
    assert.equal(h.service.currentSessionMeta.planMode, false);
  } finally {
    await h.close();
  }
});
test("IME, Shift+Enter, startup stop, running plus and recoverable operation failure", async () => {
  const h = await harness();
  try {
    h.input("你好");
    await delay(10);
    const el = h.doc.querySelector("#message-input");
    el.dispatchEvent(
      new h.dom.window.CompositionEvent("compositionstart", { bubbles: true }),
    );
    el.dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 0);
    el.dispatchEvent(
      new h.dom.window.CompositionEvent("compositionend", { bubbles: true }),
    );
    el.dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 0);
    await delay(40);
    el.dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 0);
    el.dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(
      () =>
        !h.service.processing &&
        h.service.currentSessionMeta.messages.length === 2,
    );
    const set = h.service.setPlanMode.bind(h.service);
    h.service.setPlanMode = async () => {
      throw new Error("mode fault");
    };
    h.choose("#mode-select", "plan");
    await until(() =>
      h.doc.querySelector("[role=alert]")?.textContent.includes("切换模式失败"),
    );
    assert.equal(h.service.currentSessionMeta.planMode, false);
    assert.equal(h.doc.querySelector("#mode-select").disabled, false);
    h.service.setPlanMode = set;
    h.input("hang");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() =>
      h.doc
        .querySelector(".assistant:last-child")
        ?.textContent.includes("child:"),
    );
    const old = h.service.currentSessionMeta.id;
    h.doc.querySelector("#new-session-btn").click();
    await until(() => h.service.currentSessionMeta.id !== old);
    assert.equal(h.service.isSessionRunning(old), true);
    assert.equal(h.service.processing, false);
    assert.equal(h.doc.querySelector("#mode-select").disabled, false);
  } finally {
    await h.close();
  }
});
test("bridge rejects stale and malformed operations and deduplicates IDs", async () => {
  const h = await harness();
  try {
    const id = h.service.currentSessionMeta.id;
    const req = {
      command: "togglePlanMode",
      isPlanMode: true,
      sessionId: id,
      requestId: "same",
    };
    await Promise.all([
      h.provider.bridge.receive(req),
      h.provider.bridge.receive(req),
    ]);
    assert.equal(h.service.currentSessionMeta.planMode, true);
    await h.provider.bridge.receive({
      command: "newSession",
      sessionId: "stale",
      requestId: "stale",
    });
    assert.equal(h.service.currentSessionMeta.id, id);
    await h.provider.bridge.receive({
      command: "changeModel",
      model: {},
      requestId: "malformed",
    });
    assert.equal(h.service.currentSessionMeta.model, "gemini-3.8-flash-high");
  } finally {
    await h.close();
  }
});
module.exports = { harness, until, delay };

test("active sidebar rebuild snapshots current output before periodic checkpoint; native CLI double click opens once", async () => {
  const h = await harness();
  let closed;
  try {
    h.input("hang");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() =>
      h.doc
        .querySelector(".assistant:last-child")
        ?.textContent.includes("child:"),
    );
    let snapshot;
    const listen = (m) => {
      if (m.type === "initSession") snapshot = m;
    };
    h.service.on("message", listen);
    h.service.sendSnapshot();
    h.service.off("message", listen);
    assert.ok(snapshot.activeTurn.message.content.includes("child:"));
    await h.service.abortTurn();
    await delay(20);
    let terminals = 0;
    h.service.environment.terminal = (_cli, _cwd, _args, onClose) => {
      terminals++;
      closed = onClose;
    };
    h.doc.querySelector("#native-cli-btn").click();
    h.doc.querySelector("#native-cli-btn").click();
    await until(() => terminals === 1);
    await delay(20);
    assert.equal(terminals, 1);
    assert.equal(h.sent.filter((d) => d.command === "openNativeCli").length, 1);
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
  } finally {
    closed?.();
    await h.close();
  }
});

test("Agent button counts native IDs, opens isolated transcript, and Plan approval is explicit in the real React/Provider chain", async () => {
  const h = await harness();
  try {
    h.input("hang");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() =>
      h.doc.querySelector(".assistant")?.textContent.includes("child:"),
    );
    const runner = h.service.current(),
      manager = runner.processManager;
    const events = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures/native-agent-events.json"),
        "utf8",
      ),
    );
    const native = JSON.parse(
      JSON.stringify(
        events.find((e) =>
          e.step_update?.subagent_info?.subagents?.some(
            (a) => a.conversation_id,
          ),
        ).step_update,
      ),
    );
    native.conversation_id = h.service.currentSessionMeta.cliConversationId;
    runner.agentRegistry.brainRoot = h.tmp;
    for (const a of native.subagent_info.subagents) {
      const dir = path.join(h.tmp, a.conversation_id, ".system_generated/logs");
      fs.mkdirSync(dir, { recursive: true });
      const log = path.join(dir, "transcript.jsonl");
      fs.copyFileSync(
        path.join(__dirname, "fixtures/native-child-transcript.jsonl"),
        log,
      );
      a.log_uri = require("url").pathToFileURL(log).href;
    }
    manager.emit("step_update", native, manager.currentGeneration, Date.now());
    await until(
      () => h.doc.querySelector("#agents-btn").textContent === "2 Agents",
    );
    assert(
      !h.doc.querySelector(".messages").textContent.includes("ALPHA_PROBE"),
    );
    h.doc.querySelector("#agents-btn").click();
    await until(() => h.doc.querySelectorAll(".agent-card").length === 2);
    h.doc.querySelector(".agent-card").click();
    await until(() =>
      h.doc
        .querySelector(".agent-transcript")
        ?.textContent.includes("ALPHA_PROBE"),
    );
    assert(
      !h.doc
        .querySelector(".agent-transcript")
        .textContent.includes("thinking"),
    );
    assert(
      h.doc.querySelector(".agent-card").textContent.includes("Token 暂不可用"),
    );
    await h.service.abortTurn();
    h.choose("#mode-select", "plan");
    await until(() => h.service.currentSessionMeta.planMode);
    h.input("a concrete plan");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("#approve-plan-btn"));
    assert.equal(h.service.currentSessionMeta.planMode, true);
    h.doc.querySelector("#approve-plan-btn").click();
    await until(
      () => !h.service.currentSessionMeta.planMode && !h.service.processing,
    );
    assert.equal(h.sent.filter((m) => m.command === "approvePlan").length, 1);
  } finally {
    await h.close();
  }
});

test("read-denied Plan continues to visible plan; UI reports automatic denial and has no pending approval banner", async () => {
  const h = await harness();
  try {
    h.choose("#mode-select", "plan");
    await until(() => h.service.currentSessionMeta.planMode);
    h.input("PLAN_READ_DENIED");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("#approve-plan-btn"));
    assert.match(h.doc.querySelector(".messages").textContent, /方案/);
    assert.match(
      h.doc.querySelector(".messages").textContent,
      /CLI 自动拒绝的操作/,
    );
    assert(!h.doc.body.textContent.includes("需要确认"));
    assert(!h.doc.body.textContent.includes("转到 CLI 重试"));
    assert.equal(h.sent.filter((m) => m.command === "sendMessage").length, 1);
    assert.equal(h.service.currentSessionMeta.messages.length, 2);
    assert.equal(h.service.processing, false);
  } finally {
    await h.close();
  }
});

test("parallel Plan shows not started; explicit approval creates actual agent cards and preserves counts after sidebar rebuild", async () => {
  const h = await harness();
  try {
    h.choose("#mode-select", "plan");
    await until(() => h.service.currentSessionMeta.planMode);
    h.input("多agent并行执行任务");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("#approve-plan-btn"));
    assert.match(
      h.doc.querySelector("#approve-plan-btn").textContent,
      /多 Agent/,
    );
    assert.match(h.doc.querySelector(".messages").textContent, /尚未启动/);
    assert.equal(h.doc.querySelector("#agents-btn").textContent, "0 Agents");
    h.doc.querySelector("#approve-plan-btn").click();
    await until(
      () =>
        h.doc.querySelector("#agents-btn").textContent === "2 Agents" &&
        !h.service.processing,
    );
    h.doc.querySelector("#agents-btn").click();
    await until(() => h.doc.querySelectorAll(".agent-card").length === 2);
    h.service.sendSnapshot();
    await delay(20);
    assert.equal(h.doc.querySelector("#agents-btn").textContent, "2 Agents");
  } finally {
    await h.close();
  }
});

test("slash Webview → Provider → Controller: help is local, unknown remains draft, plan/approve uses one request", async () => {
  const h = await harness();
  try {
    async function slash(text) {
      h.input(text);
      await delay(10);
      h.doc.querySelector("#send-btn").click();
      await until(
        () =>
          !h.doc.querySelector("#message-input").value ||
          h.doc.querySelector("[role=alert]"),
      );
      await delay(15);
    }
    await slash("/help");
    assert.match(h.doc.querySelector(".command-output").textContent, /\/plan/);
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
    assert(h.doc.querySelectorAll("[role=listbox]").length === 0);
    h.input("/pla");
    await delay(15);
    assert(h.doc.querySelector("[role=listbox]").textContent.includes("/plan"));
    await slash("/unknown-command");
    assert.equal(
      h.doc.querySelector("#message-input").value,
      "/unknown-command",
    );
    assert.match(h.doc.querySelector("[role=alert]").textContent, /未知命令/);
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
    h.dom.window.dispatchEvent(
      new h.dom.window.MessageEvent("message", {
        data: {
          type: "initSession",
          session: h.service.currentSessionMeta,
          config: {},
        },
      }),
    );
    h.input("/plan Plan only");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("#approve-plan-btn"));
    assert.equal(h.service.currentSessionMeta.planMode, true);
    const planId = h.service.currentSessionMeta.messages.at(-1).id;
    assert(planId);
    h.input("/approve");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(
      () =>
        !h.service.processing &&
        h.service.currentSessionMeta.planMode === false &&
        h.service.currentSessionMeta.messages.at(-1).id !== planId &&
        h.service.currentSessionMeta.messages.at(-1).role === "assistant",
    );
    assert.match(
      h.service.currentSessionMeta.messages.at(-1).content,
      /用户已批准/,
    );
  } finally {
    await h.close();
  }
});
test("slash new and stop are usable during generation; native handoff cannot silently abort", async () => {
  const h = await harness();
  try {
    h.input("hang");
    await delay(10);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.service.processing && h.doc.querySelector("#stop-btn"));
    const old = h.service.currentSessionMeta.id;
    h.input("/cli");
    await delay(10);
    h.doc.querySelector("#command-send-btn").click();
    await until(() => h.doc.querySelector("[role=alert]"));
    assert.equal(h.service.processing, true);
    assert.equal(h.service.currentSessionMeta.id, old);
    h.input("/new");
    await delay(10);
    h.doc.querySelector("#command-send-btn").click();
    await until(() => h.service.currentSessionMeta.id !== old);
    assert(h.service.isSessionRunning(old));
    await h.service.switchSession(old);
    await delay(20);
    h.input("/stop");
    await delay(10);
    h.doc.querySelector("#command-send-btn").click();
    await until(() => !h.service.processing);
    assert.equal(
      h.service.currentSessionMeta.messages.at(-1).status,
      "aborted",
    );
  } finally {
    await h.close();
  }
});
test("slash model inventory, options, max rejection and native management produce no model history", async () => {
  const h = await harness();
  try {
    async function slash(text) {
      h.input(text);
      await delay(10);
      h.doc.querySelector("#send-btn").click();
      await until(
        () =>
          !h.doc.querySelector("#message-input").value ||
          h.doc.querySelector("[role=alert]"),
      );
      await delay(15);
    }
    await slash("/model");
    assert(
      [...h.doc.querySelector("#model-select").options].some(
        (o) => o.value === "gemini-3.6-flash-low",
      ),
    );
    await slash("/effort max");
    assert.match(h.doc.querySelector("[role=alert]").textContent, /max/);
    assert.equal(h.service.currentSessionMeta.effort, "high");
    await slash("/agent research-agent");
    await until(
      () => h.service.currentSessionMeta.customAgent === "research-agent",
    );
    await slash("/sandbox on");
    assert(h.service.currentSessionMeta.sandbox);
    const file = path.join(h.tmp, "schema.json");
    fs.writeFileSync(file, JSON.stringify({ type: "object" }));
    await slash('/schema "' + file + '"');
    assert.equal(h.service.currentSessionMeta.schemaPath, file);
    await slash("/mcp list");
    await slash("/plugins list");
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
  } finally {
    await h.close();
  }
});

test("late model and agent discovery cannot change the newly selected conversation", async () => {
  const h = await harness();
  try {
    for (const command of ["/model custom-model", "/agent research-agent"]) {
      let release;
      h.provider.management.run = () => new Promise((r) => (release = r));
      const started = h.provider.executeSlash(command, "late-discovery");
      await until(() => release);
      await h.service.newSession(true);
      const fresh = h.service.currentSessionMeta;
      release("custom-model\tCustom\nresearch-agent\n");
      await assert.rejects(started, /会话已切换/);
      assert.equal(h.service.currentSessionMeta.id, fresh.id);
      assert.equal(fresh.model, "gemini-3.8-flash-high");
      assert.equal(fresh.customAgent, undefined);
    }
  } finally {
    await h.close();
  }
});

test("slash Plan forwards selected context and keeps the approval boundary", async () => {
  const h = await harness();
  try {
    await h.provider.executeSlash("/plan Review selection", "context-command", {
      code: "SELECTION_MARKER220",
      file: "example.ts:1-3",
    });
    await until(
      () =>
        !h.service.processing &&
        h.service.currentSessionMeta.messages.at(-1)?.role === "assistant",
    );
    assert(
      h.service.currentSessionMeta.messages
        .at(-1)
        .content.includes("SELECTION_MARKER220"),
    );
    assert.equal(h.service.currentSessionMeta.planMode, true);
    assert.equal(
      h.service.currentSessionMeta.messages.at(-1).status,
      "completed",
    );
  } finally {
    await h.close();
  }
});
test("safe failed slash draft survives switching; successful command clears disk; credential draft stays memory only", async () => {
  const h = await harness();
  try {
    const first = h.service.currentSessionMeta.id;
    await h.service.sendMessage("draft restoration baseline");
    await until(() => !h.service.processing && h.service.currentSessionMeta.messages.at(-1)?.role === "assistant");
    const messageCount = h.service.currentSessionMeta.messages.length;
    h.input("/effort incorrect");
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("[role=alert]"));
    assert.equal(h.service.currentSessionMeta.draft, "/effort incorrect");
    h.doc.querySelector("#new-session-btn").click();
    await until(() => h.service.currentSessionMeta.id !== first);
    await delay(25);
    h.choose("#session-select", first);
    await until(() => h.doc.querySelector("#message-input").value === "/effort incorrect");
    h.input("/help");
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".command-output") && !h.doc.querySelector("#message-input").value);
    await until(() => h.service.currentSessionMeta.draft === "");
    assert.equal(h.service.currentSessionMeta.messages.length, messageCount);
    const secretDraft = "/mcp add sentinel-never-persist-572489";
    h.input(secretDraft);
    await delay(350);
    assert.equal(h.doc.querySelector("#message-input").value, secretDraft);
    assert.equal(h.service.currentSessionMeta.draft, "");
    await h.repo.flush();
    const files = fs.readdirSync(h.tmp, {recursive: true});
    for (const entry of files) {
      const file = path.join(h.tmp, entry);
      if (fs.statSync(file).isFile()) assert(!fs.readFileSync(file, "utf8").includes("sentinel-never-persist-572489"), file);
    }
  } finally {await h.close();}
});
test("completed local command with failed draft cleanup reports save failure without implying command retry", async () => {
  const h = await harness();
  const save = h.repo.saveDraftMetadata.bind(h.repo);
  try {
    h.repo.saveDraftMetadata = session => {
      if (!session.draft) throw new Error("cleanup disk unavailable");
      return save(session);
    };
    h.input("/help");
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector("[role=alert]")?.textContent.includes("命令已完成"));
    assert(h.doc.querySelector(".command-output").textContent.includes("/plan"));
    assert.equal(h.sent.filter(m => m.command === "sendMessage" && m.text === "/help").length, 1);
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
    assert.equal(h.doc.querySelector("#message-input").value, "");
    assert(!h.doc.querySelector("[role=alert]").textContent.includes("/help失败"));
  } finally {h.repo.saveDraftMetadata = save; await h.close();}
});
test("shared command validation rejects malformed management before subprocess and skills cache invalidation", async () => {
  const h = await harness();
  const management = h.provider.management;
  const run = management.run.bind(management), clear = management.clear.bind(management);
  let runs = 0, clears = 0;
  try {
    management.run = async () => {runs++; return "unexpected";};
    management.clear = () => {clears++;};
    for (const text of ["/mcp enable ../outside", "/plugin install --token=secret", "/skills invalid", "/help extra"]) {
      await assert.rejects(h.provider.executeSlash(text), /用法/);
    }
    assert.equal(runs, 0);
    assert.equal(clears, 0);
    assert.equal(h.service.currentSessionMeta.messages.length, 0);
  } finally {management.run = run; management.clear = clear; await h.close();}
});
test("ten thousand histories keep a bounded recent list and do not rerender on unrelated draft changes", async () => {
  const h = await harness();
  try {
    // Let the initial Coordinator list publication finish before this synthetic index.
    await delay(100);
    let reads = 0;
    const id = h.service.currentSessionMeta.id;
    const sessions = [{id, title: 'current', updatedAt: 1}, ...Array.from({length: 10000}, (_, i) => ({
      id: 'history-' + i, get title() {reads++; return 'history title ' + i;}, updatedAt: i,
    }))];
    h.dom.window.dispatchEvent(new h.dom.window.MessageEvent('message', {data: {type: 'sessionList', currentId: id, sessions}}));
    await until(() => h.doc.querySelectorAll('#session-select option').length === 200);
    const baseline = reads;
    assert(baseline >= 199 && baseline < 10000);
    assert.match(h.doc.querySelector("#all-history-btn").textContent, /10001/);
    h.input('draft does not change history');
    await delay(30);
    assert.equal(reads, baseline, 'memoized options retain existing elements');
    assert.equal(h.doc.querySelector('#session-select option[value="history-198"]').textContent, 'history title 198');
    const updated = sessions.slice();
    updated[199] = {id: 'history-198', title: 'renamed history', updatedAt: 10001};
    h.dom.window.dispatchEvent(new h.dom.window.MessageEvent('message', {data: {type: 'sessionList', currentId: id, sessions: updated}}));
    await until(() => h.doc.querySelector('#session-select option[value="history-198"]').textContent === 'renamed history');
    assert.equal(reads, baseline + 1, 'only changed row title is read for comparison; other rows do not render');
    assert.equal(h.doc.querySelector('#message-input').value, 'draft does not change history');
  } finally {await h.close();}
});
test("history selection failure restores the actual selected option after isolated select updates", async () => {
  const h = await harness();
  const switchSession = h.service.switchSession.bind(h.service);
  try {
    const first = h.service.currentSessionMeta.id;
    await h.service.newSession(true);
    const second = h.service.currentSessionMeta.id;
    await until(() => h.doc.querySelector('#session-select').value === second);
    h.service.switchSession = async () => {throw new Error('history selection unavailable');};
    h.choose('#session-select', first);
    await until(() => h.doc.querySelector('[role=alert]')?.textContent.includes('history selection unavailable'));
    await until(() => h.doc.querySelector('#session-select').value === second);
    assert.equal(h.service.currentSessionMeta.id, second);
  } finally {h.service.switchSession = switchSession; await h.close();}
});
test("all-history picker reaches old records beyond recent limit, preserves draft and background turn; cancel keeps selection", async () => {
  const h = await harness();
  const picker = mock.window.showQuickPick;
  try {
    const main = h.service.currentSessionMeta.id;
    await h.service.sendMessage('hang');
    const old = h.repo.createSession('older-native-picker', 'gemini-3.8-flash-high', 'high', 'Older target');
    old.workspaceRoot = root;
    old.draft = 'old unsent draft';
    h.repo.saveSession(old);
    h.repo.setCurrentSessionId(main);
    for (let i = 0; i < 10000; i++) h.repo.sessions.set('picker-index-' + i, {
      id: 'picker-index-' + i, title: 'Recent ' + i, updatedAt: Date.now() + 1000000 + i, createdAt: i,
      model: 'gemini-3.8-flash-high', effort: 'high', totalTokens: 0, messages: [], messageCount: 0,
    });
    h.service.sendSnapshot();
    await until(() => h.doc.querySelector('#all-history-btn'));
    assert(!h.doc.querySelector('#session-select option[value="older-native-picker"]'));
    h.input('main saved before opening picker');
    mock.window.showQuickPick = async (items, options) => {
      assert.equal(items.length, 10002);
      assert.equal(options.matchOnDescription, true);
      assert.equal(h.repo.getSession(main).draft, 'main saved before opening picker');
      return items.find(item => item.sessionId === old.id);
    };
    h.doc.querySelector('#all-history-btn').click();
    await until(() => h.doc.querySelector('#session-select').value === old.id);
    assert.equal(h.doc.querySelector('#session-select').options.length, 202, 'recent 200 + selected old record + running background');
    assert(h.doc.querySelector('#session-select option[value="' + main + '"]'));
    assert.equal(h.doc.querySelector('#message-input').value, 'old unsent draft');
    assert(h.service.isSessionRunning(main));
    assert.equal(h.sent.filter(message => message.command === 'pickSession').length, 1);
    await until(() => !h.doc.querySelector('#all-history-btn').disabled);
    mock.window.showQuickPick = async () => undefined;
    h.doc.querySelector('#all-history-btn').click();
    await until(() => h.sent.filter(message => message.command === 'pickSession').length === 2);
    await until(() => !h.doc.querySelector('#all-history-btn').disabled);
    assert.equal(h.service.currentSessionMeta.id, old.id);
    assert.equal(h.doc.querySelector('#message-input').value, 'old unsent draft');
  } finally {mock.window.showQuickPick = picker; await h.close();}
});
test("late native history picker cannot overwrite a newer selected session", async () => {
  const h = await harness();
  const picker = mock.window.showQuickPick;
  try {
    let finish, opened;
    const start = new Promise(resolve => opened = resolve);
    mock.window.showQuickPick = items => {opened(); return new Promise(resolve => finish = () => resolve(items[0]));};
    const pending = h.provider.pickHistory();
    await start;
    await h.service.newSession(true);
    const selected = h.service.currentSessionMeta.id;
    finish();
    await assert.rejects(pending, /会话已切换/);
    assert.equal(h.service.currentSessionMeta.id, selected);
  } finally {mock.window.showQuickPick = picker; await h.close();}
});


test("capabilities command reports the actual verified CLI without a model turn", async () => {
  const h = await harness();
  try {
    h.input('/capabilities refresh');
    await until(()=>h.doc.querySelector('#send-btn') && !h.doc.querySelector('#send-btn').disabled);
    h.doc.querySelector('#send-btn').click();
    await until(() => h.doc.querySelector('.command-output')?.textContent.includes('1.2.14'));
    const output=h.doc.querySelector('.command-output').textContent;
    assert.match(output,/verified/);assert.match(output,/experimental/);assert.match(output,/launch-only/);
    assert.equal(h.service.currentSessionMeta.messages.length,0);
    assert.equal(h.service.processing,false);
    await until(()=>h.doc.querySelector('#message-input').value==='');
  } finally {await h.close();}
});

test("unknown CLI Webview preserves failed input and labels native fallback as standalone", async () => {
  const h = await harness();
  const oldCli=config.get('cliPath');
  const create=mock.window.createTerminal, onClose=mock.window.onDidCloseTerminal;
  const terminals=[];let closed;
  try {
    const unknown=path.join(h.tmp,'unknown-cli.cjs');
    fs.writeFileSync(unknown,'#!/usr/bin/env node\nconsole.log("9.9.9");',{mode:0o700});
    config.set('cliPath',unknown);
    mock.window.createTerminal=options=>{const terminal={options,show(){}};terminals.push(terminal);return terminal;};
    mock.window.onDidCloseTerminal=callback=>{closed=callback;return{dispose(){}};};
    h.input('请执行未知版本任务');await until(()=>!h.doc.querySelector('#send-btn').disabled);
    h.doc.querySelector('#send-btn').click();
    await until(()=>h.doc.querySelector('[role=alert]')?.textContent.includes('协议未验证'));
    assert.equal(h.doc.querySelector('#message-input').value,'请执行未知版本任务');
    assert.equal(h.service.currentSessionMeta.draft,'请执行未知版本任务');
    assert.equal(h.service.currentSessionMeta.messages.length,0);
    h.input('/cli');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>h.doc.querySelector('.command-output')?.textContent.includes('独立原生终端'));
    const output=h.doc.querySelector('.command-output').textContent;
    assert.match(output,/未复用/);assert.match(output,/不会导入/);
    assert.equal(terminals.length,1);assert.deepEqual(terminals[0].options.shellArgs,[]);
    assert.equal(h.service.currentSessionMeta.cliConversationId,undefined);
    closed(terminals[0]);
  } finally {config.set('cliPath',oldCli);mock.window.createTerminal=create;mock.window.onDidCloseTerminal=onClose;await h.close();}
});

test("restored native-owned history disables execution settings and recovers after terminal closes", async () => {
  const h = await harness();
  let closed;
  try {
    h.service.environment.terminal = (_cli, _cwd, _args, onClose) => {closed = onClose;};
    const first = h.service.currentSessionMeta.id;
    h.input("before native ownership");
    await until(() => !h.doc.querySelector("#send-btn").disabled);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".assistant")?.textContent.includes("before native ownership") && h.doc.querySelector("#send-btn"));
    h.doc.querySelector("#native-cli-btn").click();
    await until(() => closed && h.service.currentSessionMeta.id !== first);
    h.choose("#session-select", first);
    await until(() => h.doc.querySelector('[role="status"]')?.textContent.includes("原生 CLI 终端持有"));
    assert.equal(h.doc.querySelector("#mode-select").disabled, true);
    assert.equal(h.doc.querySelector("#stop-btn"), null);
    h.input("keep draft while native owns execution");
    await until(() => h.doc.querySelector("#message-input").value.includes("keep draft"));
    assert.equal(h.doc.querySelector("#send-btn").disabled, true);
    closed(); closed = undefined;
    await until(() => !h.doc.querySelector('[role="status"]')?.textContent.includes("原生 CLI 终端持有") && !h.doc.querySelector("#mode-select").disabled);
    assert.equal(h.doc.querySelector("#message-input").value, "keep draft while native owns execution");
    await until(() => !h.doc.querySelector("#send-btn").disabled);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".assistant:last-child")?.textContent.includes("keep draft while native owns execution"));
  } finally {closed?.(); await h.close();}
});

test("diagnostics export uses chosen destination, excludes prompt and paths, cancel retains journal and adds no model messages", async () => {
  const h = await harness();
  const saveDialog = mock.window.showSaveDialog, workspaceFs = mock.workspace.fs;
  const writes = [];
  try {
    h.input("opaque-private-prompt 中文");
    await until(() => !h.doc.querySelector("#send-btn").disabled);
    h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".assistant")?.textContent.includes("opaque-private-prompt") && h.doc.querySelector("#send-btn"));
    const messageCount = h.service.currentSessionMeta.messages.length;
    const target = {fsPath: path.join(h.tmp, "chosen-diagnostics.json")};
    mock.window.showSaveDialog = async () => target;
    mock.workspace.fs = {writeFile: async (uri, bytes) => writes.push({uri, text: bytes.toString("utf8")})};
    h.input("/diagnostics export"); await until(() => !h.doc.querySelector("#send-btn").disabled); h.doc.querySelector("#send-btn").click();
    await until(() => writes.length === 1 && h.doc.querySelector(".command-output")?.textContent.includes("时间线已导出"));
    assert.equal(writes[0].uri, target);
    const report = JSON.parse(writes[0].text);
    assert(report.events.some(event => event.milestone === "stdin-submitted"));
    assert(report.events.some(event => event.milestone === "first-cli-text"));
    assert(report.processes.length > 0);
    for (const privateText of ["opaque-private-prompt", "中文", h.tmp, root, config.get("cliPath")]) assert(!writes[0].text.includes(privateText));
    await until(() => h.doc.querySelector("#message-input").value === "");
    mock.window.showSaveDialog = async () => undefined;
    h.input("/diagnostics export"); await until(() => !h.doc.querySelector("#send-btn").disabled); h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".command-output")?.textContent.includes("已取消导出"));
    assert.equal(writes.length, 1);
    assert(h.service.diagnosticsSnapshot().events.length > 0);
    await until(() => h.doc.querySelector("#message-input").value === "");
    h.input("/diagnostics clear"); await until(() => !h.doc.querySelector("#send-btn").disabled); h.doc.querySelector("#send-btn").click();
    await until(() => h.doc.querySelector(".command-output")?.textContent.includes("时间线已清空"));
    assert.equal(h.service.diagnosticsSnapshot().events.length, 0);
    assert.equal(h.service.currentSessionMeta.messages.length, messageCount);
  } finally {mock.window.showSaveDialog = saveDialog; mock.workspace.fs = workspaceFs; await h.close();}
});

test("real Webview retries unconfirmed Stop while excluding send and settings, then resumes after group exit", async () => {
  const groups = require('../out/core/processGroup');
  const {ProcessExitUnconfirmedError} = require('../out/core/operationErrors');
  const verifyExit = groups.waitForProcessGroupExit;
  const h = await harness();
  let runtime;
  const failedCompletionRuntime = [];
  h.service.on('message', message => {
    if (message.type === 'runtime') runtime = message;
    if (message.type === 'turnComplete' && message.changes?.status === 'failed')
      failedCompletionRuntime.push(runtime?.terminationPending);
  });
  async function send(text) {
    h.input(text);
    await until(() => h.doc.querySelector('#send-btn') && !h.doc.querySelector('#send-btn').disabled);
    h.doc.querySelector('#send-btn').click();
  }
  try {
    await send('warm before stop fault');
    await until(() => h.service.currentSessionMeta.messages.at(-1)?.content === 'warm before stop fault' && !h.service.processing);
    await send('hang');
    const runner = h.service.executionTarget();
    await until(() => runner.turn?.blocks.get(1)?.startsWith('child:') && h.doc.querySelector('#stop-btn') && !h.doc.querySelector('#stop-btn').disabled);
    const cliId = h.service.currentSessionMeta.cliConversationId;
    groups.waitForProcessGroupExit = async () => false;
    h.doc.querySelector('#stop-btn').click();
    await until(() => runner.terminationPending && h.service.currentSessionMeta.messages.at(-1)?.status === 'failed' && h.doc.querySelector('#stop-btn') && !h.doc.querySelector('#stop-btn').disabled && h.doc.querySelector('[role=alert]')?.textContent.includes('退出未确认'));
    assert.deepEqual(failedCompletionRuntime, [true], 'unconfirmed runtime precedes completion so Send cannot flash enabled');
    const output = h.service.currentSessionMeta.messages.at(-1).content;
    assert.match(output, /^child:\d+$/);
    assert.match(h.service.currentSessionMeta.messages.at(-1).error, /退出未确认/);
    assert(!h.doc.querySelector('#send-btn'), 'ordinary Send stays hidden while exit is unconfirmed');
    assert.equal(h.doc.querySelector('#mode-select').disabled, true);
    const messages = h.service.currentSessionMeta.messages.length;
    await assert.rejects(h.service.sendMessage('must not restart'), ProcessExitUnconfirmedError);
    await assert.rejects(runner.setExecutionOptions({sandbox: true}), ProcessExitUnconfirmedError);
    assert.equal(h.service.currentSessionMeta.messages.length, messages);
    assert.throws(() => h.repo.acquireExecution(cliId), /已有执行器/);
    groups.waitForProcessGroupExit = verifyExit;
    h.doc.querySelector('#stop-btn').click();
    await until(() => !runner.terminationPending && !h.doc.querySelector('#stop-btn'));
    assert.equal(runner.processManager.exitConfirmed, true);
    assert.equal(h.service.currentSessionMeta.messages.at(-1).content, output);
    h.repo.acquireExecution(cliId)();
    await send('after retry stop');
    await until(() => h.service.currentSessionMeta.messages.at(-1)?.content === 'after retry stop' && !h.service.processing);
    assert.equal(h.sent.filter(message => message.command === 'abortCurrentTurn').length, 2);
  } finally {groups.waitForProcessGroupExit = verifyExit; await h.close();}
});

test("real Webview stop during version probe restores input after its owned query group exits", async () => {
  if(process.platform==='win32')return;
  const h=await harness(),oldCli=config.get('cliPath');
  try{
    const cli=path.join(h.tmp,'slow-version.cjs'),marker=path.join(h.tmp,'version-pids');
    fs.writeFileSync(cli,'#!/usr/bin/env node\nconst fs=require("fs");const child=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync('+JSON.stringify(marker)+',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);',{mode:0o700});
    config.set('cliPath',cli);h.input('取消启动仍保留输入');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>fs.existsSync(marker)&&h.doc.querySelector('#stop-btn'));
    const pids=JSON.parse(fs.readFileSync(marker,'utf8')),start=performance.now();
    h.doc.querySelector('#stop-btn').click();
    await until(()=>h.doc.querySelector('#send-btn')&&!h.doc.querySelector('#send-btn').disabled);
    assert.equal(h.service.processing,false);assert.equal(h.doc.querySelector('#message-input').value,'取消启动仍保留输入');
    assert.equal(h.service.currentSessionMeta.draft,'取消启动仍保留输入');
    for(const pid of pids){try{assert(/\) Z /.test(fs.readFileSync('/proc/'+pid+'/stat','utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}}
    assert(performance.now()-start<1000,'stop does not wait for probe timeout');
    assert.equal(h.sent.filter(message=>message.command==='abortCurrentTurn').length,1);
    assert(!h.doc.querySelector('[role=alert]')?.textContent.includes('发送失败'),'requested stop is not mislabeled as send failure');
  }finally{config.set('cliPath',oldCli);await h.close();}
});


test("completed Markdown file click opens exact URI/location through Webview and reports retryable failures", async () => {
  const h = await harness();
  const saved = {file: mock.Uri.file, parse: mock.Uri.parse, Position: mock.Position, Range: mock.Range,
    open: mock.workspace.openTextDocument, show: mock.window.showTextDocument};
  const {pathToFileURL, fileURLToPath} = require('node:url');
  const file = path.join(h.tmp, '文 件%20.ts');
  fs.writeFileSync(file, 'first\nsecond\n');
  const shown = [];
  const uri = value => ({fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => value});
  mock.Uri.file = value => uri(pathToFileURL(value).toString());
  mock.Uri.parse = uri;
  mock.Position = class {constructor(line, character) {this.line = line; this.character = character;}};
  mock.Range = class {constructor(start, end) {this.start = start; this.end = end;}};
  const open = async target => ({uri: target, lineCount: 3, lineAt: i => ({text: ['first', 'second', ''][i]})});
  mock.workspace.openTextDocument = open;
  mock.window.showTextDocument = async (document, options) => shown.push({document, options});
  try {
    const href = pathToFileURL(file).toString() + '#L2C4';
    await h.service.sendMessage(`[source](${href})`);
    await until(() => !h.service.processing && h.doc.querySelector('.assistant .markdown a'));
    const click = () => h.doc.querySelector('.assistant .markdown a').click();
    click();
    await until(() => shown.length === 1);
    assert.equal(shown[0].document.uri.fsPath, file);
    assert.deepEqual({...shown[0].options.selection.start}, {line: 1, character: 3});
    const request = h.sent.filter(item => item.command === 'openResource');
    assert.equal(request.length, 1);
    assert.equal(request[0].href, href);
    assert.equal(request[0].sessionId, h.service.currentSessionMeta.id);
    mock.workspace.openTextDocument = async () => {throw new Error('file open EACCES');};
    click();
    await until(() => h.doc.querySelector('.assistant [role=alert]')?.textContent.includes('EACCES'));
    assert.equal(shown.length, 1);
    mock.workspace.openTextDocument = open;
    click();
    await until(() => shown.length === 2);
    await until(() => !h.doc.querySelector('.assistant [role=alert]'));
    assert.equal(h.sent.filter(item => item.command === 'openResource').length, 3);
    let releaseDocument, loading = false;
    mock.workspace.openTextDocument = target => new Promise(resolve => {
      loading = true;
      releaseDocument = () => resolve(open(target));
    });
    const oldSessionId = h.service.currentSessionMeta.id;
    click();
    await until(() => loading);
    const pendingRequest = h.sent.filter(item => item.command === 'openResource').at(-1);
    await h.service.newSession();
    assert.notEqual(h.service.currentSessionMeta.id, oldSessionId);
    releaseDocument();
    await until(() => h.received.some(item => item.type === 'requestFailed' && item.requestId === pendingRequest.requestId));
    const failure = h.received.find(item => item.type === 'requestFailed' && item.requestId === pendingRequest.requestId);
    assert.equal(failure.command, 'openResource');
    assert.equal(failure.sessionId, oldSessionId);
    assert.match(failure.message, /会话已切换/);
    assert.equal(shown.length, 2);

  } finally {
    mock.Uri.file = saved.file; mock.Uri.parse = saved.parse; mock.Position = saved.Position; mock.Range = saved.Range;
    mock.workspace.openTextDocument = saved.open; mock.window.showTextDocument = saved.show;
    h.provider.dispose();
    await h.close();
  }
});

test('real file picker request is bound to its source session and cannot attach after New Conversation', async () => {
  const h = await harness();
  const saved = {dialog:mock.window.showOpenDialog,open:mock.workspace.openTextDocument};
  let resolvePicker, pickerOpened=false, reads=0;
  mock.window.showOpenDialog = () => {pickerOpened=true; return new Promise(resolve=>resolvePicker=resolve);};
  mock.workspace.openTextDocument = async uri => {reads++; return {uri,version:1,lineCount:1,getText:()=> 'late file'};};
  try {
    await h.service.sendMessage('picker baseline');
    await until(() => !h.service.processing);
    const oldId=h.service.currentSessionMeta.id;
    [...h.doc.querySelectorAll('.actions button')].find(button=>button.textContent==='文件').click();
    await until(()=>pickerOpened);
    const request=h.sent.filter(item=>item.command==='requestContext').at(-1);
    h.doc.querySelector('#new-session-btn').click();
    await until(()=>h.service.currentSessionMeta.id!==oldId);
    resolvePicker([{fsPath:'/project/late.ts',toString:()=> 'file:///project/late.ts'}]);
    await until(()=>h.received.some(item=>item.type==='requestFailed' && item.requestId===request.requestId));
    assert.equal(reads,0);
    assert.equal(h.service.currentSessionMeta.attachment,undefined);
    assert.equal(h.repo.getSession(oldId).attachment,undefined);
    const failed=h.received.find(item=>item.type==='requestFailed' && item.requestId===request.requestId);
    assert.equal(failed.command,'requestContext'); assert.equal(failed.sessionId,oldId);
    assert.match(failed.message,/会话已切换/);
  } finally {
    resolvePicker?.(undefined);
    mock.window.showOpenDialog=saved.dialog; mock.workspace.openTextDocument=saved.open;
    h.provider.dispose(); await h.close();
  }
});

test('real file read merges selection attached while loading and preserves both snapshots', async () => {
  const h=await harness();
  const saved={dialog:mock.window.showOpenDialog,open:mock.workspace.openTextDocument,editor:mock.window.activeTextEditor};
  let resolveDocument,reading=false;
  const file={fsPath:'/project/file.ts',toString:()=> 'file:///project/file.ts'};
  mock.window.showOpenDialog=async()=>[file];
  mock.workspace.openTextDocument=()=>{reading=true;return new Promise(resolve=>resolveDocument=resolve);};
  const selection={isEmpty:false,start:{line:3,character:2},end:{line:4,character:5}};
  mock.window.activeTextEditor={selection,document:{uri:{fsPath:'/project/selection.ts',toString:()=> 'file:///project/selection.ts'},version:7,getText:()=> 'selected while loading'}};
  const button=text=>[...h.doc.querySelectorAll('.actions button')].find(button=>button.textContent===text);
  try {
    button('文件').click();
    await until(()=>reading);
    button('选区').click();
    await until(()=>h.service.currentSessionMeta.attachment?.items.length===1);
    resolveDocument({uri:file,version:3,lineCount:2,getText:()=> 'file body'});
    await until(()=>h.service.currentSessionMeta.attachment?.items.length===2 && h.doc.querySelectorAll('.attachment').length===2);
    const items=h.service.currentSessionMeta.attachment.items;
    assert.equal(items[0].code,'selected while loading');
    assert.equal(items[0].version,7);
    assert.deepEqual(items[0].range,{start:{line:3,character:2},end:{line:4,character:5}});
    assert.equal(items[1].uri,'file:///project/file.ts');
    assert.equal(items[1].code,'file body');
    assert.equal(h.sent.filter(item=>item.command==='requestContext').length,2);
    assert.equal(h.service.currentSessionMeta.messages.length,0);
  } finally {
    resolveDocument?.({uri:file,version:3,lineCount:2,getText:()=> 'file body'});
    mock.window.showOpenDialog=saved.dialog;mock.workspace.openTextDocument=saved.open;mock.window.activeTextEditor=saved.editor;
    h.provider.dispose(); await h.close();
  }
});

test('actual React source DOM yields bounded one-way first/completed render diagnostics and preserves UI errors', async () => {
  // JSDOM geometry is explicitly mocked; this verifies message/source correlation,
  // not compositor pixels or the final Chromium latency gate.
  const h=await harness({renderVisible:true});
  try {
    await h.service.sendMessage('hang');
    await until(()=>h.sent.some(item=>item.command==='reportRender'));
    const sent=h.sent.find(item=>item.command==='reportRender');
    assert.equal(sent.receipt.kind,'firstText');assert.equal(sent.receipt.messageId,h.doc.querySelector('.assistant').dataset.messageId);
    assert.equal(sent.requestId,undefined);
    const events=h.service.diagnosticsSnapshot().events;
    assert(events.some(event=>event.milestone==='webview-first-posted'));
    assert(events.some(event=>event.milestone==='webview-render' && event.kind==='firstText'));
    assert(!h.received.some(item=>item.type==='requestComplete' && item.command==='reportRender'));
    h.provider.postMessage({type:'error',message:'retain this existing interface error'});
    await until(()=>h.doc.body.textContent.includes('retain this existing interface error'));
    const renderEvents=()=>h.service.diagnosticsSnapshot().events.filter(event=>event.milestone==='webview-render');
    const before=renderEvents().length;
    await h.receive({command:'reportRender',receipt:{...sent.receipt,token:'forged'}});
    await h.receive(sent);
    assert.equal(renderEvents().length,before);
    assert(h.doc.body.textContent.includes('retain this existing interface error'));
    const runner=h.service.executionTarget();
    for(let i=0;i<200;i++)runner.processManager.emit('step_update',{step_index:1,step_type:'agent_response',state:'ACTIVE',text_delta:'more'},runner.processManager.currentGeneration,Date.now());
    await delay(60);assert.equal(h.sent.filter(item=>item.command==='reportRender').length,1);
    await h.service.abortTurn();
    await until(()=>h.sent.some(item=>item.command==='reportRender' && item.receipt.kind==='completedText'));
    assert.equal(h.sent.filter(item=>item.command==='reportRender').length,2);
    const serialized=JSON.stringify(h.service.diagnosticsSnapshot());
    assert(!serialized.includes('child:'));assert(!serialized.includes('moremore'));
  } finally {h.provider.dispose();await h.close();}
});

test('hidden Host text produces no telemetry IPC and showing recovers a separately marked source sample', async () => {
  const h=await harness({renderVisible:true});
  try {
    h.setVisible(false);
    await h.service.sendMessage('hang');await delay(80);
    assert.equal(h.sent.filter(item=>item.command==='reportRender').length,0);
    h.setVisible(true);
    await until(()=>h.sent.some(item=>item.command==='reportRender' && item.receipt.kind==='restoredText'));
    const restored=h.sent.find(item=>item.command==='reportRender');
    assert.equal(restored.receipt.sessionId,h.service.currentSessionMeta.id);
    assert(h.service.diagnosticsSnapshot().events.some(event=>event.milestone==='webview-render' && event.kind==='restoredText'));
    const oldEpoch=restored.receipt.viewEpoch;
    h.disposeView();
    const count=h.service.diagnosticsSnapshot().events.length;
    await h.receive(restored);
    assert.equal(h.service.diagnosticsSnapshot().events.length,count);
    assert.equal(h.provider.renderTelemetry.stats().pending,0);
    assert(oldEpoch>0);
  } finally {h.provider.dispose();await h.close();}
});

test('actual Plan approval rechecks the unchanged object after mode transition and allows a later explicit retry',async()=>{
  const h=await harness();let release,runner,originalSet,originalSend;
  try {
    h.choose('#mode-select','plan');await until(()=>h.service.currentSessionMeta.planMode);
    h.input('a concrete plan');await delay(10);h.doc.querySelector('#send-btn').click();
    await until(()=>h.doc.querySelector('#approve-plan-btn')&&!h.service.processing);
    const session=h.service.currentSessionMeta,message=session.messages.at(-1),body=message.content;
    runner=h.service.executionTarget();originalSet=runner.setPlanMode.bind(runner);originalSend=runner.processManager.sendMessage.bind(runner.processManager);
    let entered=false,submitted=0;const gate=new Promise(resolve=>release=resolve);
    runner.setPlanMode=async enabled=>{await originalSet(enabled);if(!enabled){entered=true;await gate;}};
    runner.processManager.sendMessage=async(...args)=>{submitted++;return originalSend(...args);};
    h.doc.querySelector('#approve-plan-btn').click();await until(()=>entered);
    message.content+=' changed during approval';release();
    await until(()=>h.received.some(event=>event.type==='requestFailed'&&event.message.includes('批准对象已变化')));
    assert.equal(submitted,0,'changed approval must never reach CLI stdin');assert.equal(session.messages.length,2);
    assert.equal(h.service.processing,false);assert.equal(h.service.currentSessionMeta,session);
    runner.setPlanMode=originalSet;message.content=body;
    await h.service.setPlanMode(true);await until(()=>h.doc.querySelector('#approve-plan-btn')&&!h.doc.querySelector('#approve-plan-btn').disabled);
    h.doc.querySelector('#approve-plan-btn').click();
    await until(()=>session.messages.length===4&&session.messages.at(-1).status==='completed');
    assert.equal(submitted,1);assert.equal(h.sent.filter(request=>request.command==='approvePlan').length,2);
    assert.equal(session.messages.at(-1).isPlanMode,false);
  } finally {
    release?.();if(runner&&originalSet)runner.setPlanMode=originalSet;
    if(runner&&originalSend)runner.processManager.sendMessage=originalSend;
    await h.close();
  }
});

test('large Unicode CLI delta is delivered in bounded source-preserving fragments before step completion',async()=>{
  const h=await harness();
  try {
    await h.service.sendMessage('hang');const runner=h.service.executionTarget();
    const generation=runner.processManager.currentGeneration;
    await until(()=>h.doc.querySelector('.assistant')?.textContent.includes('child:'));
    const before=runner.copyText('last'),start=h.received.length;
    const source='a'.repeat(16383)+'🙂'+'b'.repeat(70000)+'\n中文';
    runner.processManager.emit('step_update',{step_index:2,step_type:'agent_response',state:'DONE',text_delta:source},generation,0);
    await until(()=>h.doc.querySelector('.assistant')?.textContent.includes(source));
    const events=h.received.slice(start),parts=events.filter(event=>event.type==='streamDelta');
    assert(parts.length>1);assert.equal(parts.map(event=>event.delta).join(''),source);
    for(const part of parts){assert(part.delta.length<=16384);assert.equal(part.receivedAt,0);assert(!/[\uD800-\uDBFF]$/.test(part.delta));assert(!/^[\uDC00-\uDFFF]/.test(part.delta));}
    assert(events.findIndex(event=>event.type==='stepDone')>events.map(event=>event.type).lastIndexOf('streamDelta'));
    assert.equal(runner.copyText('last'),before+source);
    await h.service.abortTurn();await h.repo.flush();
    assert.equal(h.service.currentSessionMeta.messages.at(-1).content,before+source);
    assert.equal(runner.turn,undefined);
  } finally {await h.close();}
});

test('Agent detail from old session cannot block new-session cards or publish late failure there', async()=>{
  const h=await harness();const original=h.service.agentDetail.bind(h.service);let rejectOld;
  try {
    const first=h.service.currentSessionMeta.id;
    await h.service.sendMessage('多 Agent 并行执行：只读调查');
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.some(m=>m.role==='assistant'));
    await h.service.newSession(true);const second=h.service.currentSessionMeta.id;
    await h.service.sendMessage('多 Agent 并行执行：第二次只读调查');
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.some(m=>m.role==='assistant'));
    const calls=[];
    h.service.agentDetail=async(agentId,offset)=>{
      const sessionId=h.service.currentSessionMeta.id;calls.push({sessionId,agentId,offset});
      if(sessionId===first)await new Promise((_resolve,reject)=>{rejectOld=reject;});
      else h.service.emit('message',{type:'agentDetail',sessionId,agentId,text:'CURRENT_AGENT_PUBLIC_TEXT',nextOffset:20,hasMore:false});
    };
    h.choose('#session-select',first);await until(()=>h.service.currentSessionMeta.id===first&&h.doc.querySelector('#session-select').value===first);
    h.doc.querySelector('#agents-btn').click();await until(()=>h.doc.querySelectorAll('.agent-card').length===2);
    h.doc.querySelector('.agent-card').click();await until(()=>rejectOld);
    h.choose('#session-select',second);await until(()=>h.service.currentSessionMeta.id===second&&h.doc.querySelector('#session-select').value===second);
    h.doc.querySelector('#agents-btn').click();await until(()=>h.doc.querySelectorAll('.agent-card').length===2);
    h.doc.querySelector('.agent-card').click();await delay(50);
    assert.equal(calls.filter(c=>c.sessionId===second).length,1,'old loading must not disable new detail requests');
    await until(()=>h.doc.querySelector('.agent-transcript')?.textContent.includes('CURRENT_AGENT_PUBLIC_TEXT'));
    rejectOld(new Error('OLD_AGENT_DETAIL_FAILED'));await delay(30);
    assert.equal(h.doc.querySelector('.agent-dialog [role=alert]')?.textContent.includes('OLD_AGENT_DETAIL_FAILED')||false,false);
    assert(h.doc.querySelector('.agent-transcript').textContent.includes('CURRENT_AGENT_PUBLIC_TEXT'));
  } finally {
    rejectOld?.(new Error('cleanup old fixture request'));
    h.service.agentDetail=original;await h.close();
  }
});

test('Agent card repeated clicks submit one pending detail request',async()=>{
  const h=await harness();const original=h.service.agentDetail.bind(h.service);let finish;
  try {
    await h.service.sendMessage('多 Agent 并行执行：只读调查');
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.some(m=>m.role==='assistant'));
    let count=0;const gate=new Promise(resolve=>{finish=resolve;});
    h.service.agentDetail=async()=>{count++;await gate;};
    h.doc.querySelector('#agents-btn').click();await until(()=>h.doc.querySelectorAll('.agent-card').length===2);
    const card=h.doc.querySelector('.agent-card');card.click();card.click();
    await until(()=>count>0);await delay(30);
    assert.equal(count,1);
    finish();await delay(20);
  } finally {finish?.();h.service.agentDetail=original;await h.close();}
});

test('exit-event claim release I/O is reported without throwing and real sidebar can retry',async()=>{
  const h=await harness();const rename=fs.renameSync;let runner;
  try {
    h.input('retained after release failure');
    await until(()=>h.received.some(m=>m.type==='requestComplete'&&m.command==='saveDraft'));
    await h.repo.flush();
    runner=h.service.executionTarget();const session=runner.currentSessionMeta;
    runner.releaseLock=h.repo.acquireExecution(session.id);runner.releaseLock.markExecutionPending();
    assert.equal(runner.processManager.exitConfirmed,true);
    const failure=Object.assign(new Error('injected claim release EIO'),{code:'EIO'});
    fs.renameSync=(source,destination,...args)=>{if(String(source).startsWith(h.tmp)&&String(destination).includes('.released-'))throw failure;return rename(source,destination,...args);};
    assert.doesNotThrow(()=>runner.processManager.emit('exit',{generation:runner.processManager.currentGeneration,code:0}));
    await until(()=>h.doc.querySelector('#stop-btn')&&!h.doc.querySelector('#stop-btn').disabled);
    assert.equal(runner.executionClaimPending,true);assert.equal(h.repo.executionClaims.has(session.id),true);
    assert.equal(h.doc.querySelector('#mode-select').disabled,true);
    assert(h.doc.querySelector('#stop-btn').textContent.includes('释放'));
    assert.equal(h.doc.querySelector('#message-input').value,'retained after release failure');
    fs.renameSync=rename;h.doc.querySelector('#stop-btn').click();
    await until(()=>!runner.executionClaimPending&&h.doc.querySelector('#send-btn'));
    assert.equal(h.repo.executionClaims.has(session.id),false);
    assert.equal(h.doc.querySelector('#mode-select').disabled,false);
    assert.equal(h.doc.querySelector('#message-input').value,'retained after release failure');
  } finally {fs.renameSync=rename;await h.close();}
});

test('real CLI group stops despite release I/O fault and sidebar preserves output through explicit release retry',async()=>{
  const h=await harness();const rename=fs.renameSync;let runner;
  try {
    h.input('hang');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    runner=h.service.executionTarget();await until(()=>runner.turn?.blocks.get(1)?.startsWith('child:')&&h.doc.querySelector('#stop-btn')&&!h.doc.querySelector('#stop-btn').disabled);
    await h.repo.flush();const group=runner.processManager.processPid;const native=runner.currentSessionMeta.cliConversationId;assert(group&&native);
    const output=runner.turn.blocks.get(1);
    fs.renameSync=(source,destination,...args)=>{if(String(source).startsWith(h.tmp)&&String(destination).includes('.released-'))throw Object.assign(new Error('actual Stop release EIO'),{code:'EIO'});return rename(source,destination,...args);};
    h.doc.querySelector('#stop-btn').click();
    await until(()=>runner.executionClaimPending&&runner.processManager.exitConfirmed&&!h.service.processing&&h.doc.querySelector('#stop-btn')&&!h.doc.querySelector('#stop-btn').disabled);
    assert.equal(await require('../out/core/processGroup').processGroupExited(group),true);
    assert.equal(h.repo.executionClaims.has(native),true);
    assert(h.service.currentSessionMeta.messages.at(-1).content.includes(output));
    await assert.rejects(h.service.sendMessage('must not submit while retained'),/执行锁释放/);
    await assert.rejects(h.service.setPlanMode(true),/执行锁释放/);
    h.input('new draft after stopped output');await until(()=>h.service.currentSessionMeta.draft==='new draft after stopped output');
    fs.renameSync=rename;h.doc.querySelector('#stop-btn').click();
    await until(()=>!runner.executionClaimPending&&h.doc.querySelector('#send-btn')&&!h.doc.querySelector('#send-btn').disabled);
    assert.equal(h.repo.executionClaims.has(native),false);assert(h.service.currentSessionMeta.messages.at(-1).content.includes(output));
    assert.equal(h.doc.querySelector('#message-input').value,'new draft after stopped output');
    h.doc.querySelector('#send-btn').click();await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.at(-1)?.content==='new draft after stopped output');
  } finally {fs.renameSync=rename;await h.close();}
});

test('closed native terminal release failure stays owned by restored Controller and sidebar retries without reopening terminal',async()=>{
  const h=await harness();const rename=fs.renameSync;let closed,owner,first;
  try {
    let terminals=0;h.service.environment.terminal=(_cli,_cwd,_args,onClose)=>{terminals++;closed=onClose;};
    first=h.service.currentSessionMeta.id;owner=h.service.executionTarget();
    h.input('before close failure');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.at(-1)?.content==='before close failure');
    h.doc.querySelector('#native-cli-btn').click();await until(()=>closed&&h.service.currentSessionMeta.id!==first);
    h.choose('#session-select',first);await until(()=>h.service.currentSessionMeta.id===first&&h.doc.querySelector('#session-select').value===first);
    assert.equal(h.service.executionTarget(),owner,'restore must reuse Controller owning terminal callbacks');
    fs.renameSync=(source,destination,...args)=>{if(String(source).startsWith(h.tmp)&&String(destination).includes('.released-'))throw Object.assign(new Error('native close release EIO'),{code:'EIO'});return rename(source,destination,...args);};
    closed();closed();
    await until(()=>owner.executionClaimPending&&h.doc.querySelector('#stop-btn')&&!h.doc.querySelector('#stop-btn').disabled);
    assert.equal(h.repo.hasNativeExecution(owner.currentSessionMeta.cliConversationId),true);
    assert.equal(h.doc.querySelector('#mode-select').disabled,true);assert.equal(terminals,1);
    fs.renameSync=rename;h.doc.querySelector('#stop-btn').click();
    await until(()=>!owner.executionClaimPending&&!h.repo.hasNativeExecution(owner.currentSessionMeta.cliConversationId)&&h.doc.querySelector('#send-btn'));
    assert.equal(terminals,1);assert.equal(h.doc.querySelector('#mode-select').disabled,false);
    h.input('after native release retry');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.at(-1)?.content==='after native release retry');
  } finally {
    fs.renameSync=rename;closed?.();await delay(25);
    if(owner?.ownsNativeSession(first)){owner.prepareOrSwitchSessionUI(first);await owner.abortTurn().catch(()=>{});}
    await h.close();
  }
});


test("extracted Webview runtime acquires API and sends ready once across renders and new conversations",async()=>{
  const h=await harness();
  try {
    assert.equal(h.apiAcquisitions(),1);assert.equal(h.sent.filter(m=>m.command==='ready').length,1);
    h.input('runtime draft');await until(()=>h.doc.querySelector('#message-input').value==='runtime draft');
    h.doc.querySelector('#new-session-btn').click();
    await until(()=>h.sent.some(m=>m.command==='newSession')&&!h.doc.querySelector('#new-session-btn').disabled);
    h.input('runtime send');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>!h.service.processing&&h.service.currentSessionMeta.messages.at(-1)?.content==='runtime send');
    assert.equal(h.apiAcquisitions(),1);assert.equal(h.sent.filter(m=>m.command==='ready').length,1);
    assert.equal(h.sent.filter(m=>m.command==='sendMessage').length,1);
  } finally {await h.close();}
});

test('actual send and stop emit one matched local-duration boundary each and retain request to turn correlation',async()=>{
  const h=await harness(),runner=h.service.executionTarget(),save=runner.saveDraft;
  try{
    runner.saveDraft=async function(...args){await delay(45);return save.apply(this,args);};
    h.input('hang');await until(()=>!h.doc.querySelector('#send-btn').disabled);h.doc.querySelector('#send-btn').click();
    await until(()=>runner.turn?.blocks.get(1)?.startsWith('child:')&&h.doc.querySelector('#stop-btn'));
    const submit=h.sent.find(m=>m.command==='sendMessage');assert(submit.requestTiming.uiQueuedMs>=40);
    const sendBoundary=h.service.diagnosticsSnapshot().events.find(e=>e.milestone==='request-boundary'&&e.command==='sendMessage');assert(sendBoundary);assert(sendBoundary.uiQueuedMs>=40);assert(sendBoundary.postToObservedUpperBoundMs>=0);
    const accepted=h.service.diagnosticsSnapshot().events.find(e=>e.milestone==='accepted');assert.equal(accepted.request,sendBoundary.request);
    h.doc.querySelector('#stop-btn').click();await until(()=>!h.service.processing&&h.doc.querySelector('#send-btn'));
    const boundaries=h.service.diagnosticsSnapshot().events.filter(e=>e.milestone==='request-boundary');assert.equal(boundaries.length,2);
    const stop=boundaries.find(e=>e.command==='abortCurrentTurn');assert.equal(stop.turn,accepted.turn);
    assert.equal(h.received.filter(m=>m.type==='requestObserved').length,2);assert.equal(h.sent.filter(m=>m.command==='reportRequestLatency').length,2);
    const receipt=h.sent.find(m=>m.command==='reportRequestLatency').receipt;
    await h.receive({command:'reportRequestLatency',receipt});await h.receive({command:'reportRequestLatency',receipt:{...receipt,token:'forged'}});
    assert.equal(h.service.diagnosticsSnapshot().events.filter(e=>e.milestone==='request-boundary').length,2);
    assert(!JSON.stringify(boundaries).includes(h.tmp));assert(!JSON.stringify(boundaries).includes('hang'));
  }finally{runner.saveDraft=save;await h.close();}
});

test("100 actual Agent panel clicks release real filesystem watchers and keep child logs isolated", {timeout: 60000}, async () => {
  const h = await harness();
  try {
    const {pathToFileURL} = require("node:url");
    const runner = h.service.executionTarget();
    const registry = runner.agentRegistry;
    assert(registry, "controller owns its actual registry");
    registry.brainRoot = h.tmp; // Fixture confines actual fs.watch to test-owned logs.
    const agents = [];
    const files = [];
    for (const id of ["panel-child-1", "panel-child-2"]) {
      const directory = path.join(h.tmp, id, ".system_generated", "logs");
      await fs.promises.mkdir(directory, {recursive: true});
      const file = path.join(directory, "transcript.jsonl");
      await fs.promises.writeFile(file, "");
      files.push(file);
      agents.push({conversation_id:id, role:id, log_uri:pathToFileURL(file).href});
    }
    registry.ingest({step_type:"subagent", subagent_info:{subagents:agents}});
    await until(() => h.doc.querySelector("#agents-btn")?.textContent === "2 Agents");
    const count = (command, enabled) => h.sent.filter(m => m.command === command &&
      (enabled === undefined || m.enabled === enabled)).length;
    const initialOpen = count("watchAgents", true), initialClose = count("watchAgents", false);
    const initialDetails = count("getAgentDetail");
    let maxPending = 0;
    for (let index = 0; index < 100; index++) {
      const marker = "CHILD_PUBLIC_PANEL_CYCLE_" + index + "_END";
      await fs.promises.appendFile(files[0], JSON.stringify({source:"MODEL", type:"PLANNER_RESPONSE",
        status:"DONE", content:marker, thinking:"PRIVATE_PANEL_THINKING"}) + "\n");
      h.doc.querySelector("#agents-btn").click();
      await until(() => {
        maxPending = Math.max(maxPending, registry.pendingWatches.size);
        return h.doc.querySelector("#agents-btn")?.getAttribute("aria-expanded") === "true" &&
          registry.watchers.size === 2 && registry.pendingWatches.size === 0;
      });
      assert.equal(h.doc.querySelectorAll(".agent-card").length, 2);
      h.doc.querySelector('.agent-card[data-agent-id="panel-child-1"]').click();
      await until(() => count("getAgentDetail") === initialDetails + index + 1 &&
        h.doc.querySelector(".agent-transcript")?.textContent.includes(marker));
      assert(!h.doc.querySelector(".agent-transcript").textContent.includes("PRIVATE_PANEL_THINKING"));
      assert(!h.doc.querySelector(".messages").textContent.includes("CHILD_PUBLIC_PANEL_CYCLE_"));
      h.doc.querySelector("#agents-btn").click();
      await until(() => h.doc.querySelector("#agents-btn")?.getAttribute("aria-expanded") === "false" &&
        registry.watchers.size === 0 && registry.pendingWatches.size === 0);
      assert.equal(registry.timer, undefined);
      assert.equal(h.doc.querySelector(".agent-content"), null);
      assert.equal(count("watchAgents", true), initialOpen + index + 1);
      assert.equal(count("watchAgents", false), initialClose + index + 1);
    }
    assert(maxPending <= 2);
    assert.equal(h.service.runners.size, 1);
    assert.equal(runner.processManager.active, false, "panel requests do not start a CLI");
    await h.service.dispose();
    assert.equal(registry.watchers.size, 0);
    assert.equal(registry.pendingWatches.size, 0);
    assert.equal(registry.timer, undefined);
  } finally {await h.close();}
});

test('real Webview timeline renders early reads before Plan text and survives history snapshot; errors are visible and bounded',async()=>{
 const h=await harness();try {
  await h.service.sendMessage('hang');const runner=h.service.executionTarget(),manager=runner.processManager,generation=manager.currentGeneration;
  await until(()=>runner.turn?.blocks.get(1)?.startsWith('child:'));
  const emit=s=>manager.emit('step_update',s,generation,Date.now());
  emit({step_index:2,step_type:'tool',state:'DONE',tool_name:'view_file',tool_info:{name:'view_file',parameters:{AbsolutePath:'/project/ref.png'},output:'image loaded'}});
  emit({step_index:4,step_type:'tool',state:'DONE',tool_name:'list_dir',tool_info:{name:'list_dir',parameters:{DirectoryPath:'/project'}}});
  emit({step_index:8,step_type:'agent_response',state:'DONE',text_delta:'方案正文252'});
  await until(()=>h.doc.querySelector('.assistant')?.textContent.includes('方案正文252'));
  let text=h.doc.querySelector('.assistant').textContent;assert(text.indexOf('已读取')<text.indexOf('已列出'));assert(text.indexOf('已列出')<text.indexOf('方案正文252'));
  emit({step_index:10,step_type:'error_message',state:'DONE'});await until(()=>h.doc.querySelector('.execution-notice'));assert(h.doc.querySelector('.execution-notice').textContent.includes('连续 1 次'));
  emit({step_index:10,step_type:'error_message',state:'DONE'});emit({step_index:12,step_type:'error_message',state:'DONE'});emit({step_index:14,step_type:'error_message',state:'DONE'});assert.equal(runner.activeTurnState.phase,'stopping');
  await until(()=>!h.service.processing);assert.equal(runner.currentSessionMeta.messages.at(-1).status,'failed');assert.match(runner.currentSessionMeta.messages.at(-1).error,/连续 3/);assert(manager.exitConfirmed);await until(()=>h.doc.querySelector('#prepare-resume-btn'));h.doc.querySelector('#prepare-resume-btn').click();await until(()=>h.doc.querySelector('#message-input').value.includes('先核对已有文件'));assert.equal(h.service.processing,false);
  await h.repo.flush();h.service.sendSnapshot();await delay(30);text=h.doc.querySelector('.assistant').textContent;assert(text.indexOf('已列出')<text.indexOf('方案正文252'));assert.equal(h.doc.querySelectorAll('.execution-notice').length,3);
 }finally{await h.close();}
});

test('restored screenshot attachment passes Provider storage, image-only send, history isolation and snapshot',async()=>{
 const originalFile=mock.Uri.file;mock.Uri.file=p=>({fsPath:p,toString:()=>"file://"+p});
 const h=await harness();try {
  const id=h.service.currentSessionMeta.id;
  await h.receive({command:'pasteImage',sessionId:id,requestId:'image252',image:{mime:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64'),thumbnail:'data:image/jpeg;base64,/9j/'}});
  await until(()=>h.doc.querySelector('footer img.image-thumbnail'));assert.equal(h.doc.querySelector('#send-btn').disabled,false);
  const stored=h.service.currentSessionMeta.attachment.items[0].image;assert(fs.existsSync(stored.file));assert.equal(fs.statSync(stored.file).mode&0o777,0o600);
  h.doc.querySelector('#send-btn').click();await until(()=>h.service.currentSessionMeta.messages.some(m=>m.role==='user'&&m.images?.length));await until(()=>!h.service.processing);
  assert.equal(h.doc.querySelectorAll('.user img.image-thumbnail').length,1);assert.equal(h.service.currentSessionMeta.attachment,undefined);
  await h.repo.flush();h.doc.querySelector('#new-session-btn').click();await until(()=>h.service.currentSessionMeta.id!==id);assert.equal(h.doc.querySelectorAll('img.image-thumbnail').length,0);
  h.choose('#session-select',id);await until(()=>h.doc.querySelector('.user img.image-thumbnail'));h.service.sendSnapshot();await delay(30);assert.equal(h.doc.querySelectorAll('.user img.image-thumbnail').length,1);
 }finally{await h.close();mock.Uri.file=originalFile;}
});
