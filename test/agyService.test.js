const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const configValues = new Map();
const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    showOpenDialog: async () => undefined,
  },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (key, fallback) =>
        configValues.has(key) ? configValues.get(key) : fallback,
      update: async (key, value) => {
        configValues.set(key, value);
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
  Uri: { parse: (value) => ({ fsPath: new URL(value).pathname }) },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { AgyService } = require("../out/services/agyService");
const { ChatViewProvider } = require("../out/ui/chatViewProvider");
const { SessionStore } = require("../out/core/sessionStore");
Module._load = originalLoad;

function makeContext() {
  const state = new Map();
  return {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, value) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
  };
}

test("unverified system messages do not imply permission approval or turn completion", () => {
  const context = makeContext();
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  const emitted = [];
  service.on("message", (message) => emitted.push(message));
  const turn = {
    state: {
      turnId: "turn",
      sessionId: "conv",
      generation: 2,
      phase: "responding",
      startedAt: Date.now(),
    },
    session: { id: "conv", messages: [] },
    message: {
      id: "assistant",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      status: "running",
      blocks: [],
      toolCalls: [],
    },
    user: {
      id: "user",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
      status: "sent",
    },
    blocks: new Map(),
    pending: new Map(),
    tools: new Map(),
    pendingTools: new Map(),
    toolRevisions: new Map(),
    cancelled: false,
  };
  service.current().turn = turn;
  service
    .current()
    .processManager.emit(
      "step_update",
      { step_type: "system_message", step_index: 1, state: "DONE" },
      2,
      Date.now(),
    );
  assert.equal(service.processing, true);
  assert.equal(
    emitted.some((m) => m.type === "turnAwaitingInput"),
    false,
  );
  service.dispose();
});

test("late events from an older process generation are ignored", () => {
  const context = makeContext();
  const service = new AgyService(context, new SessionStore(context));
  service.current().turn = {
    state: {
      turnId: "t",
      sessionId: "conv",
      generation: 4,
      phase: "responding",
      startedAt: Date.now(),
    },
    session: { id: "conv", messages: [] },
    message: {
      id: "m",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      toolCalls: [],
    },
    user: { id: "u", role: "user", content: "p", timestamp: Date.now() },
    blocks: new Map(),
    pending: new Map(),
    tools: new Map(),
    pendingTools: new Map(),
    toolRevisions: new Map(),
    cancelled: false,
  };
  service.current().processManager.emit(
    "step_update",
    {
      step_type: "agent_response",
      step_index: 1,
      state: "ACTIVE",
      text_delta: "stale",
    },
    3,
    Date.now(),
  );
  assert.equal(service.current().turn.message.content, "");
  service.dispose();
});

test("new draft stays local until send and duplicate send is rejected", async () => {
  configValues.clear();
  // Probe the fixture version; this unit test must not depend on the installed CLI.
  configValues.set("cliPath", path.join(__dirname, "fixtures/fake-agy.js"));
  vscodeMock.workspace.workspaceFolders = [
    { uri: { fsPath: path.resolve(__dirname, "..") } },
  ];
  const context = makeContext();
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  const draft = service.prepareOrSwitchSessionUI();
  assert.equal(draft.title, "New Conversation");
  assert.equal(service.processing, false);
  service.current().processManager.start = async () => "assigned-conversation";
  // This memory-only service test stubs CLI startup, including its PID contract.
  // No real process or persistent lease is created by this fixture.
  Object.defineProperty(service.current().processManager, 'processPid', {get: () => 12345});
  service.current().processManager.sendMessage = async () =>
    new Promise((resolve) => setTimeout(resolve, 30));
  const first = service.sendMessage("hello");
  await assert.rejects(service.sendMessage("duplicate"), /停止当前轮次/);
  await first;
  assert.equal(service.currentSessionMeta.id, draft.id);
  assert.equal(
    service.currentSessionMeta.cliConversationId,
    "assigned-conversation",
  );
  assert.equal(
    service.currentSessionMeta.workspaceRoot,
    path.resolve(__dirname, ".."),
  );
  await service.abortTurn();
  await service.dispose();
});

test("without an open workspace user must choose a folder; cancellation keeps the draft", async () => {
  vscodeMock.workspace.workspaceFolders = [];
  vscodeMock.window.showOpenDialog = async () => undefined;
  const context = makeContext();
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  service.prepareOrSwitchSessionUI();
  await assert.rejects(service.sendMessage("hello"), /VS Code 打开文件夹/);
  assert.equal(service.processing, false);
  assert.equal(service.currentSessionMeta.messages.length, 0);
  await service.dispose();
});

test("permission-denied CLI result keeps transcript and marks the turn for native handoff", () => {
  const context = makeContext();
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  const session = store.createSession("conv", "gemini-3.8-flash-high", "high");
  session.cliConversationId = "conv";
  session.workspaceRoot = path.resolve(__dirname, "..");
  const user = {
    id: "u",
    role: "user",
    content: "p",
    timestamp: Date.now(),
    status: "sent",
  };
  session.messages.push(user);
  service.current().currentSession = session;
  service.current().turn = {
    state: {
      turnId: "t",
      sessionId: "conv",
      generation: 7,
      phase: "tool",
      startedAt: Date.now(),
    },
    session,
    message: {
      id: "m",
      role: "assistant",
      content: "partial",
      timestamp: Date.now(),
      status: "running",
      blocks: [{ stepIndex: 1, text: "partial" }],
      toolCalls: [],
    },
    user,
    blocks: new Map([[1, "partial"]]),
    pending: new Map(),
    tools: new Map(),
    pendingTools: new Map(),
    toolRevisions: new Map(),
    cancelled: false,
  };
  service.current().processManager.emit(
    "result",
    {
      status: "ERROR",
      conversation_id: "conv",
      denied_actions: [{ action: "command", display_name: "command" }],
      duration_seconds: 1,
    },
    7,
  );
  assert.equal(service.processing, false);
  assert.equal(session.messages.at(-1).status, "permission_denied");
  assert.match(session.messages.at(-1).error, /原生 CLI/);
  service.dispose();
});

test("resolves workspace file links and line suffixes", () => {
  const workspaceRoot = path.resolve(__dirname, "..");
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
  const provider = new ChatViewProvider({}, new EventEmitter(), {}, {});
  assert.deepEqual(provider.resolveFileReference("README.md#L2"), {
    filePath: path.join(workspaceRoot, "README.md"),
    line: 2,
  });
  assert.deepEqual(
    provider.resolveFileReference(`file://${workspaceRoot}/package.json:3`),
    { filePath: path.join(workspaceRoot, "package.json"), line: 3 },
  );
});

test("webview receives a recoverable snapshot without starting the CLI", async () => {
  const context = makeContext();
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  let starts = 0;
  service.current().processManager.start = async () => {
    starts++;
    return "unexpected";
  };
  const messages = [];
  const provider = new ChatViewProvider(
    { fsPath: "/fake" },
    service,
    store,
    {},
  );
  provider.view = {
    webview: {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    },
    visible: true,
    show() {},
  };
  await provider.handleWebviewMessage({ command: "ready" });
  assert.ok(messages.some((message) => message.type === "initSession"));
  assert.ok(messages.some((message) => message.type === "sessionList"));
  assert.equal(starts, 0);
  await service.dispose();
});

test("multi-root workspace chooses active editor folder once and keeps remaining roots as additional directories", async () => {
  const root = path.resolve(__dirname, "..");
  const second = __dirname;
  vscodeMock.workspace.workspaceFolders = [
    { uri: { fsPath: root } },
    { uri: { fsPath: second } },
  ];
  vscodeMock.window.activeTextEditor = {
    document: { uri: { fsPath: path.join(second, "file.ts") } },
  };
  vscodeMock.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: second } });
  const context = makeContext();
  const service = new AgyService(context, new SessionStore(context));
  try {
    const s = service.prepareOrSwitchSessionUI();
    assert.equal(s.workspaceRoot, second);
    assert.deepEqual(s.workspaceDirectories, [second, root]);
    vscodeMock.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: root } });
    service.sendSnapshot();
    assert.equal(s.workspaceRoot, second);
  } finally {
    await service.dispose();
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.workspace.getWorkspaceFolder = () => undefined;
  }
});
