const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {CliStderrSummary} = require("../out/core/cliStderrSummary");
const {AgyProcessManager} = require("../out/core/agyProcessManager");

test("stderr summary retains only bounded allowlisted facts without raw secrets or paths", () => {
  const summary = new CliStderrSummary();
  const chunk = Buffer.from("EACCES /private/project Authorization: opaque-secret user prompt 中文 " + "x".repeat(10000));
  for (let i = 0; i < 20000; i++) summary.append(chunk);
  const snapshot = summary.snapshot();
  assert.equal(snapshot.bytes, chunk.length * 20000);
  assert.equal(snapshot.chunks, 20000);
  assert.equal(snapshot.inspectedBytes, CliStderrSummary.inspectionBudget);
  assert.equal(snapshot.uninspectedBytes, snapshot.bytes - snapshot.inspectedBytes);
  assert.deepEqual(snapshot.codes, {EACCES: 32});
  const exported = JSON.stringify(snapshot);
  assert(exported.length < 512);
  for (const secret of ["opaque-secret", "/private/project", "Authorization", "user prompt", "中文"]) assert(!exported.includes(secret));
  snapshot.codes.EACCES = -1;
  assert.equal(summary.snapshot().codes.EACCES, 32);
});

test("real CLI stderr without newline drains eight MiB and remains stoppable; new generation resets summary", {timeout: 10000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stderr-"));
  const cli = path.join(root, "stderr-cli.cjs");
  const manager = new AgyProcessManager();
  const bytes = 8 * 1024 * 1024;
  fs.writeFileSync(cli, `#!/usr/bin/env node
const payload=Buffer.alloc(${bytes},120);
payload.write('ENOSPC hidden-secret /private/project ');
process.stderr.write(payload,()=>process.stdout.write(JSON.stringify({event:'init',conversation_id:'stderr-fixture',init:{cwd:process.cwd()}})+'\\n'));
setInterval(()=>{},1000);
`, {mode: 0o700});
  try {
    await manager.start({cliPath: cli, cwd: root});
    const deadline = Date.now() + 3000;
    while (manager.stderrDiagnostics.bytes !== bytes && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.stderrDiagnostics.bytes, bytes);
    assert(manager.stderrDiagnostics.inspectedBytes <= CliStderrSummary.inspectionBudget);
    assert(JSON.stringify(manager.stderrDiagnostics).length < 512);
    assert(!JSON.stringify(manager.stderrDiagnostics).includes("hidden-secret"));
    await manager.stop("SIGTERM", 100);
    assert.equal(manager.exitConfirmed, true);
    await manager.start({cliPath: path.join(__dirname, "fixtures/fake-agy.js"), cwd: root});
    assert.equal(manager.stderrDiagnostics.bytes, 0);
    assert.deepEqual(manager.stderrDiagnostics.codes, {});
  } finally {await manager.stop("SIGTERM", 100); fs.rmSync(root, {recursive:true, force:true});}
});
