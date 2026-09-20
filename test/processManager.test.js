const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { AgyProcessManager } = require("../out/core/agyProcessManager");

const fakeCli = path.join(__dirname, "fixtures", "fake-agy.js");

test("parses fragmented NDJSON and confirms writes", async () => {
  const manager = new AgyProcessManager();
  const steps = [];
  manager.on("step_update", (step) => steps.push(step));
  const rawOutput = once(manager, "raw_output");

  const conversationId = await manager.start({ cliPath: fakeCli, cwd: __dirname });
  assert.equal(conversationId, "fake-conversation");

  const resultEvent = once(manager, "result");
  await manager.sendMessage("hello");
  const [result] = await resultEvent;
  const [raw] = await rawOutput;

  assert.equal(raw, "diagnostic noise");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "hello");
  assert.deepEqual(steps.map((step) => step.step_type), ["user_input", "agent_response"]);
  await manager.stop("SIGTERM", 100);
});

test("abort leaves the manager inactive and allows restart", async () => {
  const manager = new AgyProcessManager();
  await manager.start({ cliPath: fakeCli, cwd: __dirname });
  await manager.abortCurrentTurn();
  assert.equal(manager.active, false);

  const conversationId = await manager.start({ cliPath: fakeCli, cwd: __dirname });
  assert.equal(conversationId, "fake-conversation");
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
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === "--add-dir"), [
    "/workspace/primary",
    "/workspace/secondary",
  ]);
});

test("stopping during initialization rejects the pending start", async () => {
  const manager = new AgyProcessManager();
  const starting = manager.start({ cliPath: fakeCli, cwd: __dirname, model: "slow-init" });
  const rejected = assert.rejects(starting, /initialization was cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.stop("SIGTERM", 100);
  await rejected;
});
