const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ConversationCoordinator } = require("../out/conversation/coordinator");
const { ConversationRepository } = require("../out/conversation/repository");
const { AgentRegistry } = require("../out/conversation/agents");
const { AgyProcessManager } = require("../out/core/agyProcessManager");
const { ensurePlanAgent, PLAN_AGENT } = require("../out/core/planAgent");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-concurrent-"));
  const values = new Map();
  const state = {
    get: (k, d) => values.get(k) ?? d,
    update: async (k, v) => values.set(k, v),
  };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: tmp },
    globalState: state,
    workspaceState: state,
  });
  const env = {
    config: () => ({
      cliPath: path.join(__dirname, "fixtures/fake-agy.js"),
      defaultModel: "gemini-3.8-flash-high",
      reasoningEffort: "high",
      dangerouslySkipPermissions: true,
      autoScroll: true,
    }),
    workspace: () => ({ root: tmp, directories: [tmp] }),
    log() {},
    setPermissions: async () => {},
    terminal() {},
  };
  const c = new ConversationCoordinator(env, repo);
  return {
    tmp,
    repo,
    c,
    async close() {
      await c.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("execution claims exclude aliased controllers while permitting storage transactions", async () => {
  const h = setup();
  try {
    const release = h.repo.acquireExecution("aliased-cli");
    const storage = h.repo.acquire("aliased-cli");
    assert.throws(() => h.repo.acquireExecution("aliased-cli"), /已有执行器/);
    storage();
    assert.throws(() => h.repo.acquireExecution("aliased-cli"), /已有执行器/);
    release();
    const next = h.repo.acquireExecution("aliased-cli");
    release();
    assert.throws(() => h.repo.acquireExecution("aliased-cli"), /已有执行器/);
    next();
  } finally {await h.close();}
});

test("unconfirmed stop retains cross-repository exclusion and executor until verified retry", {timeout: 10000}, async () => {
  const h = setup();
  const groups = require("../out/core/processGroup");
  const { ProcessExitUnconfirmedError } = require("../out/core/operationErrors");
  const original = groups.waitForProcessGroupExit;
  const other = new ConversationRepository(h.repo.context);
  try {
    await h.c.sendMessage("hang");
    const runner = [...h.c.runners].find(r => r.currentSessionMeta?.id === h.c.currentSessionMeta.id);
    const cliId = h.c.currentSessionMeta.cliConversationId;
    const deadline = Date.now() + 3000;
    while (!runner.turn?.blocks.get(1)?.startsWith("child:") && Date.now() < deadline) await delay(5);
    assert.match(runner.turn?.blocks.get(1) || "", /^child:\d+$/, "tool subprocess must start before injecting exit failure");
    groups.waitForProcessGroupExit = async () => false;
    await assert.rejects(h.c.abortTurn(), ProcessExitUnconfirmedError);
    assert.equal(runner.terminationPending, true);
    assert.equal(runner.canEvict, false);
    assert.equal(runner.canCompactTranscript, false);
    assert.equal(h.c.currentSessionMeta.messages.at(-1).status, "failed");
    assert.throws(() => other.acquire(cliId));
    await assert.rejects(h.c.sendMessage("must not restart"), ProcessExitUnconfirmedError);
    await assert.rejects(runner.dispose(), ProcessExitUnconfirmedError);
    assert(h.c.runners.has(runner));
    groups.waitForProcessGroupExit = original;
    await h.c.abortTurn();
    assert.equal(runner.terminationPending, false);
    const release = other.acquire(cliId);
    release();
    await h.c.sendMessage("after confirmed exit");
    const completedBy = Date.now() + 3000;
    while (h.c.processing && Date.now() < completedBy) await delay(5);
    assert.equal(h.c.processing, false);
    assert.equal(h.c.currentSessionMeta.messages.at(-1).content, "after confirmed exit");
  } finally {groups.waitForProcessGroupExit = original; await h.close();}
});

for (const failure of ['acquire', 'pending', 'bind']) test(`CLI ID conversion ${failure} failure keeps original lease until cleanup is confirmed`, {timeout: 10000}, async () => {
  const h = setup();
  const groups = require('../out/core/processGroup');
  const {ProcessExitUnconfirmedError} = require('../out/core/operationErrors');
  const verifyExit = groups.waitForProcessGroupExit;
  const acquire = h.repo.acquireExecution.bind(h.repo);
  const other = new ConversationRepository(h.repo.context);
  let actualId;
  try {
    h.c.prepareOrSwitchSessionUI();
    const localId = h.c.currentSessionMeta.id;
    await require('../out/core/cliCapabilities').cliCapabilities.discover(h.c.environment.config().cliPath, h.tmp);
    h.repo.acquireExecution = (id, native) => {
      if (id === localId) return acquire(id, native);
      actualId = id;
      if (failure === 'acquire') throw new Error('injected destination claim failure');
      const lease = acquire(id, native);
      if (failure === 'pending') lease.markExecutionPending = () => {throw new Error('injected destination intent persistence failure');};
      else lease.bindProcess = () => {throw new Error('injected destination bind failure');};
      return lease;
    };
    groups.waitForProcessGroupExit = async () => false;
    await assert.rejects(h.c.sendMessage('never submit before ownership transfer'), ProcessExitUnconfirmedError);
    const runner = h.c.executionTarget();
    assert.equal(runner.terminationPending, true);
    assert(actualId, 'CLI initialization must reach ID conversion');
    assert.throws(() => other.acquire(localId), /另一个|未确认/, 'original durable lease must survive conversion failure');
    assert.throws(() => acquire(localId), /已有执行器/, 'same-repository original execution claim must survive');
    if (failure !== 'acquire') assert.throws(() => other.acquire(actualId), /另一个|未确认/, 'partly bound destination must remain owned too');
    groups.waitForProcessGroupExit = verifyExit;
    h.repo.acquireExecution = acquire;
    await h.c.abortTurn();
    assert.equal(runner.terminationPending, false);
    other.acquire(localId)();
    if (failure !== 'acquire') other.acquire(actualId)();
  } finally {
    groups.waitForProcessGroupExit = verifyExit;
    h.repo.acquireExecution = acquire;
    await h.close();
  }
});

test("two local histories aliased to one CLI ID cannot run through reentrant storage locks", {timeout: 10000}, async () => {
  const h = setup();
  try {
    await h.c.sendMessage("original owner");
    const deadline = Date.now() + 3000;
    while (h.c.processing && Date.now() < deadline) await delay(5);
    assert.equal(h.c.processing, false);
    const original = h.c.currentSessionMeta;
    const owner = h.c.executionTarget();
    const alias = h.repo.createSession("local-alias", original.model, original.effort);
    alias.cliConversationId = original.cliConversationId;
    alias.workspaceRoot = original.workspaceRoot;
    alias.workspaceDirectories = [...original.workspaceDirectories];
    h.repo.saveSession(alias);
    await h.repo.flush();
    await h.c.switchSession(alias.id);
    await assert.rejects(h.c.sendMessage("duplicate executor"), /已有执行器/);
    assert.equal(owner.processManager.active, true);
    assert.equal(h.c.executionTarget().processManager.active, false);
    await owner.abortTurn();
    await h.c.sendMessage("after owner releases");
    const completedBy = Date.now() + 3000;
    while (h.c.processing && Date.now() < completedBy) await delay(5);
    assert.equal(h.c.currentSessionMeta.messages.at(-1).content, "after owner releases");
  } finally {await h.close();}
});

test("native terminal owns restored history until close and synchronization; new stays independent", {timeout: 10000}, async () => {
  const h = setup();
  let closeTerminal;
  try {
    h.c.environment.terminal = (_cli, _cwd, _args, closed) => {closeTerminal = closed;};
    await h.c.sendMessage("before handoff");
    const deadline = Date.now() + 3000;
    while (h.c.processing && Date.now() < deadline) await delay(5);
    const original = h.c.currentSessionMeta;
    await h.c.openNativeCli();
    assert.notEqual(h.c.currentSessionMeta.id, original.id);
    await h.c.switchSession(original.id);
    const restored = h.c.executionTarget();
    assert(restored.hasNativeHandoff);
    assert.equal(restored.canEvict, false);
    assert.equal(restored.canCompactTranscript, false);
    await assert.rejects(h.c.sendMessage("conflict"), /已在原生 CLI/);
    await assert.rejects(h.c.setPlanMode(true), /已在原生 CLI/);
    await assert.rejects(h.c.setModel("gemini-3.8-flash-high", "high"), /已在原生 CLI/);
    await assert.rejects(h.c.abortTurn(), /原生终端停止/);
    await assert.rejects(h.c.deleteSession(original.id, true), /原生终端停止/);
    await assert.rejects(h.repo.deleteSession(original.id), /先关闭其终端/);
    assert(h.repo.getSession(original.id));
    await h.c.newSession();
    assert.notEqual(h.c.currentSessionMeta.id, original.id);
    assert(h.repo.hasNativeExecution(original.cliConversationId));
    await h.c.switchSession(original.id);
    closeTerminal(); closeTerminal = undefined;
    const releasedBy = Date.now() + 3000;
    while (h.repo.hasNativeExecution(original.cliConversationId) && Date.now() < releasedBy) await delay(5);
    assert.equal(restored.hasNativeHandoff, false);
    await h.c.sendMessage("after terminal close");
    const completedBy = Date.now() + 3000;
    while (h.c.processing && Date.now() < completedBy) await delay(5);
    assert.equal(h.c.currentSessionMeta.messages.at(-1).content, "after terminal close");
  } finally {closeTerminal?.(); await h.close();}
});

test("delete failure keeps selected executor reusable, stopped output and other running tasks", async () => {
  const h = setup();
  const rename = fs.promises.rename;
  try {
    await h.c.sendMessage("hang");
    const background = h.c.currentSessionMeta.id;
    await h.c.newSession(true);
    await h.c.sendMessage("hang");
    const selected = h.c.currentSessionMeta.id;
    await h.c.saveDraft("unsent draft");
    fs.promises.rename = async (from, to) => {
      if (path.basename(to).startsWith(".deleted-")) throw Object.assign(new Error("delete unavailable"), {code: "EACCES"});
      return rename(from, to);
    };
    await assert.rejects(h.c.deleteSession(selected, true), /delete unavailable/);
    assert.equal(h.c.currentSessionMeta.id, selected);
    assert(h.repo.getSession(selected));
    assert.equal(h.repo.getSession(selected).draft, "unsent draft");
    assert.equal(h.repo.getSession(selected).messages.at(-1).status, "aborted");
    assert(!h.c.processing);
    assert(h.c.isSessionRunning(background));
    fs.promises.rename = rename;
    await h.c.sendMessage("executor still usable");
    const deadline = Date.now() + 3000;
    while (h.c.processing && Date.now() < deadline) await delay(5);
    assert(!h.c.processing);
    assert.equal(h.c.currentSessionMeta.messages.at(-1).content, "executor still usable");
    await h.c.deleteSession(selected);
    assert(!h.repo.getSession(selected));
    assert(h.c.isSessionRunning(background));
  } finally { fs.promises.rename = rename; await h.close(); }
});
test("new and switching keep two independent CLI turns alive; stop affects selected only; background deltas are not delivered", async () => {
  const h = setup();
  const messages = [];
  h.c.on("message", (m) => messages.push(m));
  try {
    const a = h.c.prepareOrSwitchSessionUI().id;
    await h.c.sendMessage("hang");
    await delay(50);
    await Promise.all([h.c.newSession(), h.c.newSession()]);
    const b = h.c.currentSessionMeta.id;
    assert.notEqual(a, b);
    assert(h.c.isSessionRunning(a));
    assert(!h.c.processing);
    await h.c.sendMessage("hang");
    await delay(50);
    assert(h.c.isSessionRunning(b));
    const runner = Array.from(h.c.runners).find(
      (r) => r.currentSessionMeta.id === a,
    );
    runner.processManager.emit(
      "step_update",
      {
        step_index: 9,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: "BACKGROUND_ONLY",
      },
      runner.processManager.currentGeneration,
      Date.now(),
    );
    await delay(45);
    assert(
      !messages.some(
        (m) => m.type === "streamDelta" && m.delta === "BACKGROUND_ONLY",
      ),
    );
    await h.c.abortTurn();
    assert(!h.c.isSessionRunning(b));
    assert(h.c.isSessionRunning(a));
    await h.c.switchSession(a);
    const snapshots = [];
    h.c.on("message", (m) => snapshots.push(m));
    h.c.sendSnapshot();
    assert(
      snapshots
        .find((m) => m.type === "initSession")
        .activeTurn.message.content.includes("BACKGROUND_ONLY"),
    );
    await assert.rejects(h.c.deleteSession(a), /确认/);
    assert(h.c.processing);
    await h.c.deleteSession(a, true);
    assert(!h.repo.getSession(a));
  } finally {
    await h.close();
  }
});
test("queued history selection wins after asynchronous new conversation", async () => {
  const h = setup();
  try {
    const old = h.c.prepareOrSwitchSessionUI().id;
    h.c.saveDraft("retain");
    await Promise.all([h.c.newSession(true), h.c.switchSession(old)]);
    assert.equal(h.c.currentSessionMeta.id, old);
    assert.equal(h.c.currentSessionMeta.draft, "retain");
    assert.equal(h.repo.getAllSessions().length, 2);
  } finally {
    await h.close();
  }
});

test("session permissions persist independently; new inherits selection without changing global defaults", async () => {
  const h = setup();
  try {
    const a = h.c.prepareOrSwitchSessionUI().id;
    await h.c.setDangerouslySkipPermissions(false);
    assert.equal(
      h.c.executionTarget().getConfig().dangerouslySkipPermissions,
      false,
    );
    assert.equal(h.c.getConfig().dangerouslySkipPermissions, true);
    await h.c.newSession(true);
    const b = h.c.currentSessionMeta.id;
    assert.equal(
      h.c.executionTarget().getConfig().dangerouslySkipPermissions,
      false,
    );
    await h.c.setDangerouslySkipPermissions(true);
    await h.c.switchSession(a);
    assert.equal(
      h.c.executionTarget().getConfig().dangerouslySkipPermissions,
      false,
    );
    await h.c.sendMessage("hello");
    assert.equal(
      h.c.executionTarget().processManager.initInfo.permission_mode,
      "request-review",
    );
    await h.c.switchSession(b);
    await h.c.sendMessage("hello");
    assert.equal(
      h.c.executionTarget().processManager.initInfo.permission_mode,
      "auto",
    );
    await h.repo.flush();
    assert.equal(h.repo.getSession(a).dangerouslySkipPermissions, false);
    assert.equal(h.repo.getSession(b).dangerouslySkipPermissions, true);
  } finally {
    await h.close();
  }
});

test("rapid tool updates coalesce by step; stop flushes final tool state with bounded batches", async () => {
  const h = setup();
  const messages = [];
  h.c.on("message", (m) => messages.push(m));
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.sendMessage("hang");
    const runner = h.c.executionTarget();
    for (let i = 0; i < 500; i++)
      runner.processManager.emit(
        "step_update",
        {
          step_index: 2,
          step_type: "tool",
          tool_name: "rapid",
          state: i === 499 ? "DONE" : "ACTIVE",
          tool_info: { output: "version " + i },
        },
        runner.processManager.currentGeneration,
        Date.now(),
      );
    await delay(50);
    const batches = messages.filter((m) => m.type === "toolUpdates");
    assert.equal(batches.length, 1);
    assert.equal(batches[0].tools.length, 1);
    assert.equal(batches[0].tools[0].output, "version 499");
    assert.equal(batches[0].tools[0].state, "DONE");
    for (let i = 0; i < 100; i++)
      runner.processManager.emit(
        "step_update",
        {
          step_index: 10 + i,
          step_type: "tool",
          tool_name: "bulk",
          state: "DONE",
          tool_info: { output: "out" },
        },
        runner.processManager.currentGeneration,
        Date.now(),
      );
    await h.c.abortTurn();
    const final = messages.filter((m) => m.type === "toolUpdates").slice(1);
    assert.equal(
      final.reduce((sum, m) => sum + m.tools.length, 0),
      100,
    );
    assert(final.every((m) => m.tools.length <= 32));
  } finally {
    await h.close();
  }
});

test("new during CLI startup does not cancel old startup and new conversation sends independently", async () => {
  const h = setup();
  try {
    const a = h.c.prepareOrSwitchSessionUI().id;
    await h.c.setModel("slow-init");
    const pending = h.c.sendMessage("hang");
    await delay(20);
    await h.c.newSession();
    const b = h.c.currentSessionMeta.id;
    assert.notEqual(a, b);
    await h.c.setModel("gemini-3.8-flash-high");
    await h.c.sendMessage("hello");
    await delay(60);
    assert(!h.c.processing);
    await pending;
    assert(h.c.isSessionRunning(a));
    await h.c.switchSession(a);
    await h.c.abortTurn();
  } finally {
    await h.close();
  }
});
test("Plan uses restricted agent without Danger; stale approval fails; approval uses separate execution CLI identity", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.setPlanMode(true);
    await h.c.sendMessage("make a plan");
    await delay(70);
    const r = h.c.current(),
      s = h.c.currentSessionMeta;
    assert.equal(r.processManager.initInfo.agent, PLAN_AGENT);
    assert.equal(r.processManager.initInfo.permission_mode, "request-review");
    const planId = s.cliConversationId;
    assert.equal(s.planMode, true);
    const message = s.messages.at(-1);
    await assert.rejects(h.c.approvePlan("stale"), /方案已变化/);
    await h.c.approvePlan(message.id);
    await delay(70);
    assert.equal(s.planMode, false);
    assert.notEqual(s.cliConversationId, planId);
    assert.equal(r.processManager.initInfo.agent, undefined);
    assert.equal(r.processManager.initInfo.permission_mode, "auto");
    assert.equal(s.messages.at(-2).content, "批准并执行方案");
  } finally {
    await h.close();
  }
});
test("modified Plan agent definition fails closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-definition-"));
  try {
    ensurePlanAgent(tmp);
    fs.appendFileSync(
      path.join(tmp, ".gemini/config/agents", PLAN_AGENT, "agent.md"),
      "\nmodified",
    );
    assert.throws(() => ensurePlanAgent(tmp), /配置已变化/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("real native subagent fixture: parser accepts subagent; stable count; independent transcript projection and log path validation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agent-log-"));
  const events = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/native-agent-events.json"),
      "utf8",
    ),
  );
  const native = events.find((e) =>
    e.step_update?.subagent_info?.subagents?.some((a) => a.conversation_id),
  ).step_update;
  let changed = 0;
  const registry = new AgentRegistry([], () => changed++, tmp);
  try {
    const step = JSON.parse(JSON.stringify(native));
    for (const a of step.subagent_info.subagents) {
      const dir = path.join(tmp, a.conversation_id, ".system_generated/logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(
        file,
        JSON.stringify({
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "CHILD_VISIBLE",
          thinking: "PRIVATE_REASONING",
        }) + "\n",
      );
      a.log_uri = require("url").pathToFileURL(file).href;
    }
    registry.ingest(step);
    registry.ingest(step);
    assert.equal(registry.snapshot().length, 2);
    const a = registry.snapshot()[0];
    const page = registry.detail(a.id);
    assert(page.text.includes("CHILD_VISIBLE"));
    assert(!page.text.includes("PRIVATE_REASONING"));
    assert.equal(page.hasMore, false);
    assert.equal(a.usage, undefined);
    registry.rootFinished();
    assert(registry.snapshot().every((a) => a.state === "unknown"));
    registry.agents.get(a.id).logUri = "file:///etc/passwd";
    assert.throws(() => registry.detail(a.id), /目录/);
    const manager = new AgyProcessManager();
    const seen = [];
    manager.on("step_update", (s) => seen.push(s));
    const replay = path.join(__dirname, "fixtures/replay-agy.js");
    // Dedicated replay option uses the captured native protocol, not a fabricated shape.
    await manager.start({ cliPath: replay, cwd: tmp, model: "agents-native" });
    await manager.sendMessage("probe");
    await delay(70);
    await manager.stop();
    assert(seen.some((s) => s.step_type === "subagent" && s.subagent_info));
  } finally {
    registry.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("idle cache is bounded without touching active executors; shared store has one listener and disposal removes it", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    for (let i = 0; i < 12; i++) await h.c.newSession(true);
    await delay(70);
    assert(h.c.runners.size <= 3);
    assert.equal(h.repo.listenerCount("storageError"), 1);
    await h.c.dispose();
    assert.equal(h.repo.listenerCount("storageError"), 0);
  } finally {
    await h.close();
  }
});

test("Plan recovers a read denial once in the same turn without granting permissions", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.setPlanMode(true);
    await h.c.sendMessage("PLAN_READ_DENIED");
    await delay(120);
    const s = h.c.currentSessionMeta;
    assert.equal(s.messages.length, 2);
    const m = s.messages.at(-1);
    assert.equal(m.status, "completed");
    assert.match(m.content, /方案/);
    assert.equal(m.permissionRequests[0].displayName, "ListDir");
    assert.equal(m.toolCalls.length, 1);
    assert.equal(
      h.c.current().processManager.initInfo.permission_mode,
      "request-review",
    );
    assert.equal(s.planMode, true);
    await h.c.approvePlan(m.id);
  } finally {
    await h.close();
  }
});
test("Plan read recovery is bounded; repeated denial has accurate error and restores input", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.setPlanMode(true);
    await h.c.sendMessage("PLAN_READ_DENIED DENY_AGAIN");
    await delay(120);
    assert.equal(h.c.processing, false);
    const m = h.c.currentSessionMeta.messages.at(-1);
    assert.equal(m.status, "permission_denied");
    assert.match(m.error, /自动拒绝/);
    assert.match(m.error, /没有待审批/);
    assert.equal(h.c.currentSessionMeta.messages.length, 2);
  } finally {
    await h.close();
  }
});

test("explicit parallel request plans without spawning; approval starts two actual agents with deduplicated IDs", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.setPlanMode(true);
    await h.c.sendMessage("多agent并行执行任务");
    await delay(100);
    const plan = h.c.currentSessionMeta.messages.at(-1);
    assert.equal(plan.agentExecution.state, "planned");
    assert.equal((h.c.currentSessionMeta.agents || []).length, 0);
    await h.c.approvePlan(plan.id);
    await delay(100);
    const done = h.c.currentSessionMeta.messages.at(-1);
    assert.equal(done.status, "completed");
    assert.equal(done.agentExecution.state, "started");
    assert.deepEqual(done.agentExecution.observedIds, [
      "alpha-child",
      "beta-child",
    ]);
    assert.equal((h.c.currentSessionMeta.agents || []).length, 2);
  } finally {
    await h.close();
  }
});
test("parallel execution fails clearly on zero or one actual child; old saved children cannot satisfy new turn", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.sendMessage("多agent并行执行任务");
    await delay(100);
    for (const tag of ["NO_AGENT_EVENTS", "ONLY_ONE_AGENT"]) {
      await h.c.sendMessage("多agent并行执行 " + tag);
      await delay(100);
      const m = h.c.currentSessionMeta.messages.at(-1);
      assert.equal(m.status, "failed");
      assert.equal(m.agentExecution.state, "not_started");
      assert.match(m.error, /未按多 Agent/);
      assert.equal(h.c.processing, false);
    }
  } finally {
    await h.close();
  }
});
test("main execution before child launch requests stop and retains the offending tool", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.sendMessage("多agent并行执行 VIOLATE_SINGLE_AGENT");
    await delay(100);
    const m = h.c.currentSessionMeta.messages.at(-1);
    assert.equal(h.c.processing, false);
    assert.equal(m.status, "failed");
    assert.match(m.error, /已请求停止/);
    assert.equal(m.toolCalls[0].name, "run_command");
  } finally {
    await h.close();
  }
});
test("agent role prose never turns an ordinary approved plan into a parallel request; legacy explicit request retains intent", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    await h.c.setPlanMode(true);
    await h.c.sendMessage("给出普通方案");
    await delay(100);
    const plan = h.c.currentSessionMeta.messages.at(-1);
    plan.content = "Multi-agent parallel execution: Agent A/B";
    await h.c.approvePlan(plan.id);
    await delay(100);
    assert.equal(
      h.c.currentSessionMeta.messages.at(-1).agentExecution,
      undefined,
    );
    await h.c.setPlanMode(true);
    await h.c.sendMessage("多agent并行执行任务");
    await delay(100);
    const legacy = h.c.currentSessionMeta.messages.at(-1);
    delete legacy.agentExecution;
    await h.c.approvePlan(legacy.id);
    await delay(100);
    assert.equal(
      h.c.currentSessionMeta.messages.at(-1).agentExecution.state,
      "started",
    );
  } finally {
    await h.close();
  }
});
test("zero transcript budget protects selected, running background and native handoff executors", async () => {
  const h = setup();
  let closeTerminal;
  try {
    h.c.environment.terminal = (_cli, _cwd, _args, closed) => {closeTerminal = closed;};
    h.c.prepareOrSwitchSessionUI();
    const idle = h.c.currentSessionMeta.id;
    await h.c.newSession(true);
    await h.c.openNativeCli();
    const native = h.c.currentSessionMeta.id;
    await h.c.newSession(true);
    await h.c.sendMessage("hang");
    const background = h.c.currentSessionMeta.id;
    await h.c.newSession(true);
    const selected = h.c.currentSessionMeta.id;
    const trim = h.repo.trimTranscriptCache.bind(h.repo);
    h.repo.trimTranscriptCache = allowed => trim(allowed, {maxSessions: 0, maxBytes: 0});
    h.c.evictIdle();
    await h.repo.cacheTrim;
    assert(!h.repo.loaded.has(idle));
    for (const id of [native, background, selected]) assert(h.repo.loaded.has(id), id);
    assert(h.c.isSessionRunning(background));
    assert.equal(h.repo.cacheStats.transcripts.overBudget, true);
    assert([...h.c.runners].some(r => r.currentSessionMeta?.id === native));
  } finally {
    closeTerminal?.();
    await h.close();
  }
});
test("unchanged ten-thousand-session list suppresses timestamp-only IPC but snapshots and visible changes publish", async () => {
  const h = setup();
  try {
    h.c.prepareOrSwitchSessionUI();
    for (let i = 0; i < 10000; i++) h.repo.sessions.set('index-' + i, {
      id: 'index-' + i, title: 'History ' + i, updatedAt: i, createdAt: i,
      model: 'm', effort: 'high', totalTokens: 0, messages: [], messageCount: 0,
    });
    const lists = [];
    h.c.on('message', m => {if (m.type === 'sessionList') lists.push(m);});
    h.c.publishList();
    assert.equal(lists.length, 1);
    for (let i = 0; i < 100; i++) {h.c.currentSessionMeta.updatedAt++; h.c.publishList();}
    assert.equal(lists.length, 1);
    h.c.currentSessionMeta.title = 'Changed visible title';
    h.c.publishList(); assert.equal(lists.length, 2);
    h.c.sendSnapshot(); assert.equal(lists.length, 3, 'view reconstruction receives projected list even unchanged');
    assert.equal(lists.at(-1).sessions.length, 200);
    assert.equal(lists.at(-1).totalCount, 10001);
  } finally {await h.close();}
});


test("history IPC retains old selected, running and denied sessions with a full Host count", async () => {
  const h = setup();
  try {
    await h.c.sendMessage("hang");
    const running = h.c.currentSessionMeta.id;
    await h.c.newSession(true);
    const selected = h.c.currentSessionMeta.id;
    h.repo.sessions.get(running).updatedAt = 0;
    h.repo.sessions.get(selected).updatedAt = 1;
    for (let i = 0; i < 10000; i++) h.repo.sessions.set("projection-" + i, {
      id: "projection-" + i, title: "History " + i, updatedAt: 100 + i, createdAt: i,
      model: "m", effort: "high", totalTokens: 0, messages: [], messageCount: 0,
    });
    h.repo.sessions.get("projection-0").lastMessageStatus = "permission_denied";
    const lists = [];
    h.c.on("message", m => {if (m.type === "sessionList") lists.push(m);});
    h.c.publishList(true);
    const list = lists.at(-1);
    assert.equal(list.totalCount, 10002);
    assert.equal(list.sessions.length, 203);
    assert(list.sessions.some(s => s.id === selected));
    assert(list.sessions.some(s => s.id === running && ["connecting", "submitted", "waiting", "responding", "tool"].includes(s.phase)));
    assert(h.c.isSessionRunning(running));
    assert(list.sessions.some(s => s.id === "projection-0" && s.phase === "permission_denied"));
    assert(!list.sessions.some(s => s.id === "projection-1"));
    assert.equal(h.repo.getAllSessions().length, 10002, "full searchable Host history remains");
    // Add an older record that does not alter the projection: total count must update.
    h.repo.sessions.set("older-unseen", {...h.repo.sessions.get("projection-1"), id: "older-unseen", updatedAt: -1});
    h.c.publishList();
    assert.equal(lists.at(-1).totalCount, 10003);
    assert.equal(lists.at(-1).sessions.length, 203);
  } finally {await h.close();}
});
