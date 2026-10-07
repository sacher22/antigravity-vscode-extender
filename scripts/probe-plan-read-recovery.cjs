const fs = require("fs"),
  os = require("os"),
  path = require("path");
const { ConversationCoordinator } = require("../out/conversation/coordinator");
const { ConversationRepository } = require("../out/conversation/repository");
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plan-recovery-"));
  const work = path.join(tmp, "workspace"),
    outside = "/home/ubuntu/project";
  fs.mkdirSync(work);


  const m = new Map(),
    state = {
      get: (k, d) => m.get(k) ?? d,
      update: async (k, v) => m.set(k, v),
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
  const report = { workspace: work, events: [] };
  c.on("message", (e) => {
    if (e.type === "turnState")
      report.events.push({ phase: e.state.phase, detail: e.state.detail });
  });
  try {
    c.prepareOrSwitchSessionUI();
    await c.setPlanMode(true);
    await c.sendMessage(
      `本轮用户明确指定参考目录 ${outside}。只调用一次 list_dir 读取这个参考目录，不要读取当前工作区或其他文件，然后直接给出简短的鹈鹕骑自行车3D动画制作方案。不要写文件、运行命令或启动子代理。`,
    );
    const deadline = Date.now() + 120000;
    while (c.processing && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 500));
    const s = c.currentSessionMeta,
      a = s.messages.at(-1);
    report.cliId = s.cliConversationId;
    report.status = a.status;
    report.response = a.content;
    report.denied = a.permissionRequests;
    report.tools = a.toolCalls?.map((t) => ({
      name: t.name,
      parameters: t.parameters,
    }));
    report.workspaceFiles = fs.readdirSync(work);
    report.init = c.current().processManager.initInfo;
    fs.writeFileSync(
      "diagnostics/2.1.1-plan-read-recovery.json",
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        status: report.status,
        characters: report.response.length,
        denied: report.denied,
        files: report.workspaceFiles,
        events: report.events,
      }),
    );
    if (
      a.status !== "completed" ||
      !a.content.trim() ||
      report.workspaceFiles.length
    )
      throw Error("Acceptance failed");
  } finally {
    await c.dispose();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
