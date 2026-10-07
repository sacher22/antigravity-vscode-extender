const fs = require("fs"),
  os = require("os"),
  path = require("path");
const { ConversationCoordinator } = require("../out/conversation/coordinator");
const { ConversationRepository } = require("../out/conversation/repository");
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-parallel-plan-")),
    work = path.join(tmp, "workspace");
  fs.mkdirSync(work);
  const values = new Map(),
    state = {
      get: (k, d) => values.get(k) ?? d,
      update: async (k, v) => values.set(k, v),
    };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: path.join(tmp, "storage") },
    globalState: state,
    workspaceState: state,
  });
  const c = new ConversationCoordinator(
    {
      config: () => ({
        cliPath: path.join(os.homedir(), ".local/bin/agy"),
        defaultModel: "gemini-3.8-flash-high",
        reasoningEffort: "high",
        dangerouslySkipPermissions: true,
        autoScroll: true,
      }),
      workspace: () => ({ root: work, directories: [work] }),
      log() {},
      setPermissions: async () => {},
      terminal() {},
    },
    repo,
  );
  const r = { workspace: work, events: [] };
  c.on("message", (m) => {
    if (m.type === "agents")
      r.events.push({
        time: Date.now(),
        agents: m.agents.map((a) => ({
          id: a.id,
          state: a.state,
          role: a.role,
        })),
      });
  });
  async function done() {
    const t = Date.now();
    while (c.processing && Date.now() - t < 120000)
      await new Promise((r) => setTimeout(r, 500));
    if (c.processing) throw Error("Timed out");
  }
  try {
    c.prepareOrSwitchSessionUI();
    await c.setPlanMode(true);
    await c.sendMessage(
      "请给一个多agent并行执行的极简方案，批准后用原生 invoke_subagent 在同一次调用中启动两个 research 子代理。第一位只回答 ALPHA212，第二位只回答 BETA212，主代理等待并汇总结果。不读写文件、不执行 shell，不要启动第三个子代理。现在只输出方案等待批准。",
    );
    await done();
    const plan = c.currentSessionMeta.messages.at(-1);
    r.plan = {
      status: plan.status,
      intent: plan.agentExecution,
      content: plan.content,
    };
    if (plan.status !== "completed") throw Error("Plan failed");
    await c.approvePlan(plan.id);
    await done();
    const s = c.currentSessionMeta,
      m = s.messages.at(-1);
    r.execution = {
      status: m.status,
      intent: m.agentExecution,
      error: m.error,
      content: m.content,
      tools: m.toolCalls?.map((t) => t.name),
      cliId: s.cliConversationId,
    };
    r.agents = s.agents;
    r.files = fs.readdirSync(work);
    if (
      m.status !== "completed" ||
      m.agentExecution?.observedIds.length < 2 ||
      r.files.length
    )
      throw Error("Parallel execution not verified");
    r.passed = true;
  } catch (e) {
    r.passed = false;
    r.error = e.message;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      "diagnostics/2.1.2-parallel-plan.json",
      JSON.stringify(r, null, 2),
    );
    console.log(
      JSON.stringify({
        passed: r.passed,
        error: r.error,
        execution: r.execution?.intent,
        agents: r.agents?.length,
        files: r.files,
      }),
    );
    await c.dispose();
  }
})();
