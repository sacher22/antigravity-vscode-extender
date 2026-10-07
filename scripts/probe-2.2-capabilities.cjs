const fs = require("fs"),
  path = require("path"),
  os = require("os");
const { ConversationRepository } = require("../out/conversation/repository");
const { ConversationController } = require("../out/conversation/controller");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-2.2-real-")),
    map = new Map(),
    state = {
      get: (k, d) => (map.has(k) ? map.get(k) : d),
      update: async (k, v) => map.set(k, v),
    };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: path.join(root, "storage") },
    globalState: state,
    workspaceState: state,
  });
  const env = {
    config: () => ({
      cliPath: "/home/ubuntu/.local/bin/agy",
      defaultModel: "gemini-3.8-flash-high",
      reasoningEffort: "high",
      dangerouslySkipPermissions: false,
      autoScroll: true,
    }),
    workspace: () => ({ root, directories: [root] }),
    log() {},
    setPermissions: async () => {},
    terminal() {},
  };
  const c = new ConversationController(env, repo),
    report = { root, cli: "1.2.14", tests: [] };
  const wait = async () => {
    const start = Date.now();
    while (c.processing) {
      if (Date.now() - start > 90000) throw Error("CLI timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  try {
    c.prepareOrSwitchSessionUI();
    const schema = path.join(root, "schema.json");
    fs.writeFileSync(
      schema,
      JSON.stringify({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      }),
    );
    await c.setExecutionOptions({ schemaPath: schema, sandbox: true });
    await c.sendMessage('Return JSON {"ok":true}. Do not use tools.');
    await wait();
    const m = c.currentSessionMeta.messages.at(-1);
    report.tests.push({
      name: "sandbox + json schema",
      status: m.status,
      structured: m.structuredOutput,
      response: m.content,
      error: m.error,
    });
    await c.setExecutionOptions({ schemaPath: undefined, sandbox: false });
    const folder = path.join(root, ".agents/skills/parity-probe");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      "---\nname: parity-probe\ndescription: deterministic marker\n---\nReply exactly SKILL_PARITY_OK. Do not use tools.\n",
    );
    await c.sendMessage(
      "/parity-probe",
      undefined,
      "/parity-probe",
      false,
      true,
    );
    await wait();
    const answer = c.currentSessionMeta.messages.at(-1);
    report.tests.push({
      name: "native skill",
      status: answer.status,
      response: answer.content,
    });
    const schemaTest = report.tests[0];
    report.nativeSchemaConformant = schemaTest.status === "completed";
    report.schemaGuardVerified =
      schemaTest.status === "completed"
        ? JSON.parse(schemaTest.response).ok === true
        : schemaTest.status === "failed" &&
          /单个有效 JSON|不符合所选 Schema/.test(schemaTest.error || "");
    report.passed =
      report.schemaGuardVerified &&
      report.tests[1].status === "completed" &&
      report.tests[1].response.includes("SKILL_PARITY_OK");
  } catch (error) {
    report.error = String(error);
    report.passed = false;
  } finally {
    await c.dispose();
    fs.writeFileSync(
      path.join(__dirname, "../diagnostics/2.2-native-capabilities.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
    if (!report.passed) process.exitCode = 1;
  }
})();
