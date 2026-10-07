const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {performance, monitorEventLoopDelay} = require("node:perf_hooks");
const assert = require("node:assert/strict");
const {ConversationRepository} = require("../out/conversation/repository");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = directory => ({globalStorageUri: {fsPath: directory}, globalState: {get: (key, fallback) => fallback, update: async () => {}}});
async function measure(context, count, asynchronous) {
  const histogram = monitorEventLoopDelay({resolution: 5});
  histogram.enable();
  let last = performance.now(), heartbeatMax = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatMax = Math.max(heartbeatMax, now - last);
    last = now;
  }, 5);
  await pause(30);
  const started = performance.now(), cpu = process.cpuUsage();
  const repository = asynchronous ? await ConversationRepository.open(context) : new ConversationRepository(context);
  const elapsedMs = performance.now() - started;
  await pause(30);
  clearInterval(heartbeat);
  histogram.disable();
  assert.equal(repository.getAllSessions().length, count);
  return {mode: asynchronous ? "async-production" : "sync-compatibility-baseline", sessions: count, elapsedMs, heartbeatMaxMs: heartbeatMax, eventLoopP95Ms: histogram.percentile(95) / 1e6, eventLoopMaxMs: histogram.max / 1e6, cpuMicroseconds: process.cpuUsage(cpu)};
}
(async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agy-startup-"));
  const root = path.join(directory, "conversations-v3");
  const runs = [];
  try {
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, "migration.json"), JSON.stringify({version: 3}));
    let created = 0;
    for (const count of [1000, 10000]) {
      let next = created;
      await Promise.all(Array.from({length: 32}, async () => {
        for (;;) {
          const index = next++;
          if (index >= count) return;
          const id = "startup-" + index;
          const folder = path.join(root, createHash("sha256").update(id).digest("hex"));
          await fs.promises.mkdir(folder);
          await fs.promises.writeFile(path.join(folder, "session.json"), JSON.stringify({id, title: id, model: "gemini-3.8-flash-high", effort: "high", updatedAt: index, totalTokens: 0, messageCount: 0, draft: "synthetic draft 中文🙂 ".repeat(100)}));
        }
      }));
      created = count;
      for (let run = 0; run < 3; run++) {
        for (const asynchronous of [false, true]) {
          const result = await measure(context(directory), count, asynchronous);
          runs.push({...result, run: run + 1});
          console.log(result);
        }
      }
    }
    const report = {environment: "WSL; synthetic metadata on local filesystem; warm-cache repeated repository initialization, no CLI/Webview", runs};
    await fs.promises.writeFile(process.env.AGY_STARTUP_OUTPUT || "diagnostics/optimization-startup.json", JSON.stringify(report, null, 2));
    for (const run of runs.filter(run => run.mode === "async-production")) assert(run.heartbeatMaxMs <= 100, "asynchronous startup keeps event loop heartbeat <=100ms");
  } finally {await fs.promises.rm(directory, {recursive: true, force: true});}
})().catch(error => {console.error(error);process.exitCode = 1;});
