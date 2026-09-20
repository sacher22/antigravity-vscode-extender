const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
  },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      update: async () => undefined,
    }),
  },
  ConfigurationTarget: { Global: 1 },
  Uri: {
    parse: (value) => ({ fsPath: new URL(value).pathname }),
  },
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

test("system_message completes the UI turn while preserving the CLI process", () => {
  const context = { subscriptions: [] };
  const sessionStore = {};
  const service = new AgyService(context, sessionStore);
  const phases = [];
  let awaitingTurn;
  let awaitingKind;
  let stopCalled = false;

  service.isProcessing = true;
  service.activeTurnId = "turn-confirm";
  service.turnStartedAt = Date.now();
  service.currentAgentText = "The implementation plan is ready. Please confirm if I should proceed.";
  service.on("turn_state", (state) => phases.push(state.phase));
  service.on("awaiting_input", (turnId, kind) => {
    awaitingTurn = turnId;
    awaitingKind = kind;
  });
  service.processManager.stop = async () => { stopCalled = true; };

  service.processManager.emit("step_update", {
    conversation_id: "conversation",
    step_index: 4,
    state: "DONE",
    step_type: "system_message",
  });

  assert.equal(service.processing, false);
  assert.equal(awaitingTurn, "turn-confirm");
  assert.equal(awaitingKind, "confirmation");
  assert.deepEqual(phases, ["awaiting_input"]);
  assert.equal(stopCalled, false);
  assert.equal(
    service.classifyPendingInput("Should the file use UTF-8 with or without a trailing newline?"),
    "question"
  );
  service.dispose();
});

test("a new question declines a pending plan and keeps deliverables in the workspace", async () => {
  const workspaceRoot = path.resolve(__dirname, "..");
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
  const service = new AgyService({ subscriptions: [] }, {});
  let sentPrompt = "";

  service.currentSession = { id: "conversation", messages: [{ role: "user" }] };
  service.pendingInputKind = "confirmation";
  service.activeProcessSessionId = "conversation";
  service.processManager.isRunning = true;
  service.processManager.childProcess = {};
  service.processManager.sendMessage = async (prompt) => { sentPrompt = prompt; };

  await service.sendMessage("Why was the previous file written elsewhere?");

  assert.match(sentPrompt, /Do not execute the previously proposed plan/);
  assert.match(sentPrompt, new RegExp(`Primary root: ${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(sentPrompt, /Do not place deliverables in Antigravity scratch or brain directories/);
  service.isProcessing = false;
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
  assert.deepEqual(provider.resolveFileReference(`file://${workspaceRoot}/package.json:3`), {
    filePath: path.join(workspaceRoot, "package.json"),
    line: 3,
  });
});

test("new session reuses the current draft and removes stale empty sessions", () => {
  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, val) => { state.set(key, val); },
    },
  };
  const store = new SessionStore(context);
  const service = new AgyService(context, store);

  // Initial creation of empty session
  const sess1 = service.prepareNewSessionUI();
  assert.ok(sess1.id);
  assert.equal(sess1.title, "New Conversation");
  assert.equal(store.getCurrentSessionId(), sess1.id);
  assert.equal(service.currentSessionMeta.id, sess1.id);

  // Calling new session again when current session is empty reuses it
  store.createSession("stale-empty", "gemini-3.8-flash-high", "high");
  service.prepareOrSwitchSessionUI(sess1.id);
  const sess2 = service.prepareNewSessionUI();
  assert.equal(sess2.id, sess1.id);
  assert.equal(store.getSession("stale-empty"), undefined);

  // Add a user message to sess1 so it's no longer empty
  store.updateSessionMessages(sess1.id, [{ role: "user", content: "hello" }]);

  // Now new session creates a new session
  const sess3 = service.prepareNewSessionUI();
  assert.notEqual(sess3.id, sess1.id);

  // Switching back to sess1 returns it instantly
  const sess1Switched = service.prepareOrSwitchSessionUI(sess1.id);
  assert.equal(sess1Switched.id, sess1.id);
  assert.equal(store.getCurrentSessionId(), sess1.id);

  service.dispose();
});

test("the first draft message creates exactly one workspace-bound CLI conversation", async () => {
  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, val) => { state.set(key, val); },
    },
  };
  const workspaceRoot = path.resolve(__dirname, "..");
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  const draft = service.prepareNewSessionUI();
  const draftId = draft.id;
  let startOptions;
  let writes = 0;
  service.processManager.start = async (options) => {
    startOptions = options;
    return "assigned-conversation";
  };
  service.processManager.sendMessage = async () => { writes++; };

  await service.sendMessage("hello");

  assert.equal(startOptions.createProject, true);
  assert.deepEqual(startOptions.additionalDirectories, [workspaceRoot]);
  assert.equal(startOptions.conversationId, undefined);
  assert.equal(store.getSession(draftId), undefined);
  assert.equal(service.currentSessionMeta.id, "assigned-conversation");
  assert.equal(writes, 1);
  service.isProcessing = false;
  service.dispose();
});

test("SessionStore replaces session IDs and caches in memory", () => {
  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, val) => { state.set(key, val); },
    },
  };
  const store = new SessionStore(context);
  const created = store.createSession("sess_temp", "claude-3-7-sonnet", "low");
  assert.equal(store.getSession("sess_temp")?.id, "sess_temp");

  const migrated = store.replaceSessionId("sess_temp", "conv_assigned_uuid");
  assert.ok(migrated);
  assert.equal(migrated.id, "conv_assigned_uuid");
  assert.equal(store.getSession("sess_temp"), undefined);
  assert.equal(store.getSession("conv_assigned_uuid")?.id, "conv_assigned_uuid");
  assert.equal(store.getCurrentSessionId(), "conv_assigned_uuid");
});

test("ChatViewProvider creates a local draft without starting the CLI", async () => {
  const state = new Map();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
      update: async (key, val) => { state.set(key, val); },
    },
  };
  const store = new SessionStore(context);
  const service = new AgyService(context, store);
  let processStarts = 0;
  service.processManager.start = async () => {
    processStarts++;
    return "slow-process-id";
  };

  const postedMessages = [];
  const fakeWebview = {
    postMessage: async (msg) => { postedMessages.push(msg); return true; },
  };
  const provider = new ChatViewProvider({ fsPath: "/fake" }, service, store, {});
  provider.view = { webview: fakeWebview, visible: true, show() {} };

  await provider.handleWebviewMessage({ command: "newSession" });

  const initMsg = postedMessages.find((m) => m.type === "initSession");
  const listMsg = postedMessages.find((m) => m.type === "sessionList");
  assert.ok(initMsg, "initSession should be posted");
  assert.ok(listMsg, "sessionList should be posted");
  assert.equal(initMsg.session.messages.length, 0);
  assert.equal(processStarts, 0);

  service.dispose();
});
