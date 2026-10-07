const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { AgyProcessManager } = require("../out/core/agyProcessManager");

const fakeCli = path.join(__dirname, "fixtures", "fake-agy.js");

test("unconfirmed tool group exit blocks restart until a verified stop retry", {timeout: 5000}, async () => {
  const groups = require("../out/core/processGroup");
  const { ProcessExitUnconfirmedError } = require("../out/core/operationErrors");
  const original = groups.waitForProcessGroupExit;
  const manager = new AgyProcessManager();
  try {
    await manager.start({cliPath: fakeCli, cwd: __dirname});
    const childStarted = new Promise(resolve => manager.on("step_update", step => {
      if (step.text_delta?.startsWith("child:")) resolve();
    }));
    await manager.sendMessage("hang");
    await childStarted;
    groups.waitForProcessGroupExit = async () => false;
    await assert.rejects(manager.stop("SIGTERM", 50), ProcessExitUnconfirmedError);
    assert.equal(manager.active, false);
    assert.equal(manager.terminationUnconfirmed, true);
    assert.equal(manager.exitConfirmed, false);
    await assert.rejects(manager.start({cliPath: fakeCli, cwd: __dirname}), ProcessExitUnconfirmedError);
    groups.waitForProcessGroupExit = original;
    await manager.stop("SIGTERM", 50);
    assert.equal(manager.terminationUnconfirmed, false);
    assert.equal(manager.exitConfirmed, true);
    await manager.start({cliPath: fakeCli, cwd: __dirname});
    const result = once(manager, "result");
    await manager.sendMessage("after verified retry");
    assert.equal((await result)[0].response, "after verified retry");
  } finally {
    groups.waitForProcessGroupExit = original;
    await manager.stop("SIGTERM", 100);
  }
});

test("storage backpressure allows init, pauses output, resumes losslessly and still permits stop", {timeout: 5000}, async () => {
  const manager = new AgyProcessManager();
  const steps = [];
  manager.on("step_update", step => steps.push(step));
  try {
    manager.setOutputPaused(true);
    await manager.start({cliPath: fakeCli, cwd: __dirname});
    assert(manager.active, "init must not wait for disk pressure to clear");
    const result = once(manager, "result");
    await manager.sendMessage("hello");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(steps.length, 0);
    manager.setOutputPaused(false);
    assert.equal((await result)[0].response, "hello");
    assert.equal(steps.filter(step => step.step_type === "agent_response").length, 1);
    manager.setOutputPaused(true);
    await manager.sendMessage("hang");
    await manager.stop("SIGTERM", 100);
    assert.equal(manager.active, false);
    assert.equal(manager.outputReader, undefined);
    manager.setOutputPaused(false);
    await manager.start({cliPath: fakeCli, cwd: __dirname});
    const next = once(manager, "result");
    await manager.sendMessage("after pressure");
    assert.equal((await next)[0].response, "after pressure");
  } finally {await manager.stop("SIGTERM", 100);}
});

test("parses fragmented NDJSON and confirms writes", async () => {
  const manager = new AgyProcessManager();
  const steps = [];
  manager.on("step_update", (step) => steps.push(step));
  const rawOutput = once(manager, "raw_output");

  const conversationId = await manager.start({
    cliPath: fakeCli,
    cwd: __dirname,
  });
  assert.match(conversationId, /^fake-/);

  const resultEvent = once(manager, "result");
  await manager.sendMessage("hello");
  const [result] = await resultEvent;
  const [raw] = await rawOutput;

  assert.equal(raw, "diagnostic noise".length);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "hello");
  assert.deepEqual(
    steps.map((step) => step.step_type),
    ["user_input", "agent_response"],
  );
  await manager.stop("SIGTERM", 100);
});

test("abort leaves the manager inactive and allows restart", async () => {
  const manager = new AgyProcessManager();
  await manager.start({ cliPath: fakeCli, cwd: __dirname });
  await manager.abortCurrentTurn();
  assert.equal(manager.active, false);

  const conversationId = await manager.start({
    cliPath: fakeCli,
    cwd: __dirname,
  });
  assert.match(conversationId, /^fake-/);
  assert.equal(manager.active, true);
  await manager.stop("SIGTERM", 100);
});

test("new sessions bind the CLI project to workspace directories", () => {
  const manager = new AgyProcessManager();
  const args = manager.buildArgs({
    cliPath: fakeCli,
    cwd: "/workspace/primary",
    createProject: true,
    additionalDirectories: ["/workspace/primary", "/workspace/secondary"],
  });
  assert.ok(args.includes("--new-project"));
  assert.deepEqual(
    args.filter((arg, index) => args[index - 1] === "--add-dir"),
    ["/workspace/primary", "/workspace/secondary"],
  );
});

test("stopping during initialization rejects the pending start", async () => {
  const manager = new AgyProcessManager();
  const starting = manager.start({
    cliPath: fakeCli,
    cwd: __dirname,
    model: "slow-init",
  });
  const rejected = assert.rejects(starting, /initialization was cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.stop("SIGTERM", 100);
  await rejected;
});

test("normal and Plan always pass explicit CLI mode, including resumed conversations", () => {
  const m = new AgyProcessManager();
  for (const plan of [true, false]) {
    const a = m.buildArgs({
      cliPath: fakeCli,
      cwd: __dirname,
      conversationId: "resume",
      isPlanMode: plan,
    });
    assert.equal(a[a.indexOf("--mode") + 1], plan ? "plan" : "accept-edits");
    assert.equal(a[a.indexOf("--conversation") + 1], "resume");
  }
});

test("validated CLI 1.2.14 Plan and Safe denied-action samples replay through NDJSON parser", async () => {
  for (const model of ["replay-plan", "safe-tool"]) {
    const m = new AgyProcessManager();
    try {
      await m.start({
        cliPath: path.join(__dirname, "fixtures/replay-agy.js"),
        cwd: __dirname,
        model,
      });
      const result = once(m, "result");
      await m.sendMessage("fixture");
      const [r] = await result;
      assert.equal(r.status, "SUCCESS");
      if (model === "safe-tool") assert.ok(r.denied_actions.length > 0);
    } finally {
      await m.stop();
    }
  }
});
