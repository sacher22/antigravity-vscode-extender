const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  CliCapabilityCache,
  versionCapabilities,
  cliCapabilities,
} = require("../out/core/cliCapabilities");
const { ConversationController } = require("../out/conversation/controller");
const { ConversationRepository } = require("../out/conversation/repository");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check) => {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > 4000) throw Error("Fixture timed out");
    await delay(10);
  }
};
const fixture = (t, body) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-capability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "cli.cjs");
  fs.writeFileSync(cli, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
  return { root, cli };
};
test("version capabilities distinguish captured version, unknown versions and experimental claims", () => {
  const known = versionCapabilities("/cli", "1.2.14", 1);
  assert.equal(known.status, "verified");
  assert.equal(known.readOnlyPlan, true);
  assert.equal(known.toolApproval, false);
  assert.equal(known.schema, "experimental");
  assert.equal(known.sandbox, "launch-only");
  assert(Object.isFrozen(known));
  for (const version of ["1.2.15", "1.2.14-preview.1", undefined]) {
    const unknown = versionCapabilities("/cli", version, 1);
    assert.equal(unknown.streamJson, false);
    assert.equal(unknown.skills, false);
  }
});
test("concurrent version probes share process; TTL, replacement and refresh invalidate capabilities", async (t) => {
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const n=fs.existsSync('count')?Number(fs.readFileSync('count','utf8'))+1:1;fs.writeFileSync('count',String(n));setTimeout(()=>console.log('1.2.14'),20);",
  );
  let now = 1;
  const cache = new CliCapabilityCache(() => now, 1000);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => cache.discover(cli, root)),
  );
  assert(results.every((result) => result === results[0]));
  assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "1");
  now = 500;
  assert.equal(await cache.discover(cli, root), results[0]);
  now = 1001;
  await cache.discover(cli, root);
  assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "2");
  fs.writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("1.2.15");', {
    mode: 0o700,
  });
  assert.equal((await cache.discover(cli, root)).status, "unverified");
  cache.clear();
  assert.equal(cache.stats.entries, 0);
  assert.equal((await cache.discover(cli, root)).version, "1.2.15");
});
test("late version probe cannot repopulate refresh epoch", async (t) => {
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const n=fs.existsSync('count')?Number(fs.readFileSync('count','utf8'))+1:1;fs.writeFileSync('count',String(n));if(n===1){fs.writeFileSync('ready','1');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('1.2.14');}},10);}else console.log('1.2.15');",
  );
  const cache = new CliCapabilityCache();
  const first = cache.discover(cli, root);
  try {
    await until(() => fs.existsSync(path.join(root, "ready")));
    cache.clear();
    assert.equal((await cache.discover(cli, root)).version, "1.2.15");
    fs.writeFileSync(path.join(root, "release"), "1");
    assert.equal(
      (await first).version,
      "1.2.15",
      "waiting caller adopts fresh epoch before authorizing launch",
    );
    assert.equal((await cache.discover(cli, root)).version, "1.2.15");
    assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "2");
  } finally {
    fs.writeFileSync(path.join(root, "release"), "1");
    await first;
  }
});
test("version probe rejects arbitrary, oversized and failed output without retaining secrets", async (t) => {
  const { root, cli } = fixture(
    t,
    'console.log("API_KEY=PRIVATE_TEST_SENTINEL\\n1.2.14");',
  );
  const cache = new CliCapabilityCache();
  let result = await cache.discover(cli, root);
  assert.equal(result.status, "unavailable");
  assert(!JSON.stringify(result).includes("PRIVATE_TEST_SENTINEL"));
  fs.writeFileSync(
    cli,
    '#!/usr/bin/env node\nconsole.log("x".repeat(20000));',
    { mode: 0o700 },
  );
  result = await cache.discover(cli, root);
  assert.equal(result.status, "unavailable");
  fs.writeFileSync(
    cli,
    '#!/usr/bin/env node\nconsole.log("1.2.14");process.exit(1);',
    { mode: 0o700 },
  );
  result = await cache.discover(cli, root);
  assert.equal(result.status, "unavailable");
});
test("timed-out version query terminates only its own POSIX parent and child", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('probe-pids',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);",
  );
  const cache = new CliCapabilityCache();
  const result = await cache.discover(cli, root);
  assert.equal(result.status, "unavailable");
  const pids = JSON.parse(
    fs.readFileSync(path.join(root, "probe-pids"), "utf8"),
  );
  await until(() =>
    pids.every((pid) => {
      try {
        return /\) Z /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8"));
      } catch (e) {
        return e.code === "ENOENT";
      }
    }),
  );
});
test("unknown CLI preserves draft, blocks stream execution and opens explicit standalone native fallback", async (t) => {
  const { root, cli } = fixture(
    t,
    "require('fs').appendFileSync('queries',JSON.stringify(process.argv.slice(2))+'\\n');console.log('9.9.9');",
  );
  const state = { get: (_k, d) => d, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  const terminals = [],
    messages = [];
  const controller = new ConversationController(
    {
      config: () => ({
        cliPath: cli,
        defaultModel: "gemini-3.8-flash-high",
        reasoningEffort: "high",
        dangerouslySkipPermissions: true,
      }),
      workspace: () => ({ root, directories: [root] }),
      log() {},
      setPermissions: async () => {},
      terminal: (...args) => terminals.push(args),
    },
    repo,
  );
  t.after(async () => {
    await controller.dispose();
    cliCapabilities.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  controller.on("message", (message) => messages.push(message));
  await assert.rejects(
    controller.sendMessage("请实施修改", "unknown-version-send"),
    /协议未验证/,
  );
  assert.equal(controller.processing, false);
  assert.equal(controller.currentSessionMeta.draft, "请实施修改");
  assert.equal(controller.processManager.active, false);
  assert.equal(
    fs.readFileSync(path.join(root, "queries"), "utf8").trim(),
    '["--version"]',
  );
  const id = controller.currentSessionMeta.id;
  await controller.openNativeCli();
  assert.equal(terminals.length, 1);
  assert.equal(controller.nativeHandoffMode, "standalone");
  assert.deepEqual(terminals[0].slice(0, 3), [cli, root, []]);
  assert.equal(controller.currentSessionMeta.id, id);
  assert.equal(controller.currentSessionMeta.cliConversationId, undefined);
  assert(
    messages.some(
      (message) =>
        message.type === "notice" && message.message.includes("不会自动恢复"),
    ),
  );
  await assert.rejects(controller.openNativeCli(), /已在原生 CLI/);
  assert.equal(terminals.length, 1);
  terminals[0][3]();
  assert(
    messages.some(
      (message) =>
        message.type === "notice" && message.message.includes("没有导入"),
    ),
  );
});

test("binary replacement during a version probe is rechecked before authorizing launch", async (t) => {
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');fs.writeFileSync('ready','1');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('1.2.14');}},10);",
  );
  const cache = new CliCapabilityCache();
  const first = cache.discover(cli, root);
  try {
    await until(() => fs.existsSync(path.join(root, "ready")));
    fs.writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("9.9.9");', {
      mode: 0o700,
    });
    fs.writeFileSync(path.join(root, "release"), "1");
    const result = await first;
    assert.equal(result.version, "9.9.9");
    assert.equal(result.streamJson, false);
  } finally {
    fs.writeFileSync(path.join(root, "release"), "1");
    await first.catch(() => {});
  }
});

test("unknown version refuses management mutations while read-only queries remain available", async (t) => {
  const {
    NativeManagementAdapter,
  } = require("../out/adapters/nativeManagement");
  const { root, cli } = fixture(
    t,
    "require('fs').appendFileSync('queries',JSON.stringify(process.argv.slice(2))+'\\n');console.log(process.argv[2]==='--version'?'9.9.9':'unverified model inventory');",
  );
  const adapter = new NativeManagementAdapter();
  await assert.rejects(
    adapter.run(cli, root, ["mcp", "disable", "server"]),
    /协议未验证/,
  );
  const calls = fs.readFileSync(path.join(root, "queries"), "utf8");
  assert(!calls.includes("disable"));
  assert(calls.includes("--version"));
  assert.equal(
    await adapter.run(cli, root, ["models"], true),
    "unverified model inventory",
  );
});

test("warm turns reuse CLI and captured capabilities without starting another version query", async (t) => {
  const fake = path.join(__dirname, "fixtures/fake-agy.js");
  const { root, cli } = fixture(
    t,
    `require('fs').appendFileSync('launches', JSON.stringify(process.argv.slice(2))+'\\n');require(${JSON.stringify(fake)});`,
  );
  const state = { get: (_k, d) => d, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  const controller = new ConversationController(
    {
      config: () => ({
        cliPath: cli,
        defaultModel: "gemini-3.8-flash-high",
        reasoningEffort: "high",
        dangerouslySkipPermissions: false,
      }),
      workspace: () => ({ root, directories: [root] }),
      log() {},
      setPermissions: async () => {},
      terminal() {},
    },
    repo,
  );
  t.after(async () => {
    await controller.dispose();
    cliCapabilities.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await controller.sendMessage("first");
  await until(() => !controller.processing);
  const first = controller.currentExecutionProfile;
  const generation = controller.processManager.currentGeneration;
  assert.equal(first.capabilities.version, "1.2.14");
  assert(Object.isFrozen(first));
  await controller.sendMessage("second");
  await until(() => !controller.processing);
  assert.equal(controller.processManager.currentGeneration, generation);
  assert.equal(
    controller.currentExecutionProfile.capabilities,
    first.capabilities,
  );
  const launches = fs
    .readFileSync(path.join(root, "launches"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(launches.filter((args) => args[0] === "--version").length, 1);
  assert.equal(
    launches.filter((args) => args.includes("--output-format")).length,
    1,
  );
});

function exited(pid) {
  try {
    return /\) Z /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
test("last version consumer cancellation waits for its parent and child exit, does not cache failure, and can retry", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process group");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');if(fs.existsSync('quick')){console.log('1.2.14');}else{const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('probe-pids',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);}",
  );
  const cache = new CliCapabilityCache(),
    cancel = new AbortController();
  const first = cache.discover(cli, root, cancel.signal);
  const rejection = assert.rejects(first, /取消/);
  await until(() => fs.existsSync(path.join(root, "probe-pids")));
  const pids = JSON.parse(
    fs.readFileSync(path.join(root, "probe-pids"), "utf8"),
  );
  cancel.abort();
  await rejection;
  assert(pids.every(exited), "cancel reply waits for own group exit");
  assert.equal(cache.stats.entries, 0);
  assert.equal(cache.stats.pending, 0);
  fs.writeFileSync(path.join(root, "quick"), "1");
  assert.equal((await cache.discover(cli, root)).status, "verified");
});
test("cancelling one shared version consumer leaves the other query running and cacheable", async (t) => {
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');fs.writeFileSync('probe-pid',String(process.pid));fs.appendFileSync('count','1');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('1.2.14');}},10);",
  );
  const cache = new CliCapabilityCache(),
    a = new AbortController(),
    b = new AbortController();
  const first = cache.discover(cli, root, a.signal),
    second = cache.discover(cli, root, b.signal);
  const rejected = assert.rejects(first, /取消/);
  try {
    await until(
      () =>
        cache.stats.consumers === 2 &&
        fs.existsSync(path.join(root, "probe-pid")),
    );
    a.abort();
    await rejected;
    assert.equal(cache.stats.consumers, 1);
    assert(
      !exited(Number(fs.readFileSync(path.join(root, "probe-pid"), "utf8"))),
    );
    fs.writeFileSync(path.join(root, "release"), "1");
    assert.equal((await second).version, "1.2.14");
    assert.equal(cache.stats.entries, 1);
    assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "1");
  } finally {
    fs.writeFileSync(path.join(root, "release"), "1");
    await Promise.allSettled([first, second]);
  }
});
test("already cancelled version requests start no process, including when a cached result exists", async (t) => {
  const { root, cli } = fixture(
    t,
    "require('fs').appendFileSync('count','1');console.log('1.2.14');",
  );
  const cache = new CliCapabilityCache(),
    cancel = new AbortController();
  cancel.abort();
  await assert.rejects(cache.discover(cli, root, cancel.signal), /取消/);
  assert(!fs.existsSync(path.join(root, "count")));
  await cache.discover(cli, root);
  await assert.rejects(cache.discover(cli, root, cancel.signal), /取消/);
  assert.equal(fs.readFileSync(path.join(root, "count"), "utf8"), "1");
});
test("Controller startup stop cancels slow version probe and waits for its owned group; draft survives", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process group");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('probe-pids',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);",
  );
  const state = { get: (_key, value) => value, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  const controller = new ConversationController(
    {
      config: () => ({
        cliPath: cli,
        defaultModel: "gemini-3.8-flash-high",
        reasoningEffort: "high",
        dangerouslySkipPermissions: false,
      }),
      workspace: () => ({ root, directories: [root] }),
      log() {},
      setPermissions: async () => {},
      terminal() {},
    },
    repo,
  );
  t.after(async () => {
    await controller.dispose();
    cliCapabilities.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = controller.sendMessage("启动期间保留");
  const rejected = assert.rejects(send, /取消/);
  await until(() => fs.existsSync(path.join(root, "probe-pids")));
  const pids = JSON.parse(
    fs.readFileSync(path.join(root, "probe-pids"), "utf8"),
  );
  const start = performance.now();
  await controller.abortTurn();
  await rejected;
  assert.equal(controller.processing, false);
  assert.equal(controller.currentSessionMeta.draft, "启动期间保留");
  assert.equal(controller.processManager.active, false);
  assert(pids.every(exited));
  assert(
    performance.now() - start < 1000,
    "does not wait for the 1500ms query timeout",
  );
});

test("immediate retry of cancelled query is not erased by the old pending cleanup", async (t) => {
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const n=fs.existsSync('count')?Number(fs.readFileSync('count','utf8'))+1:1;fs.writeFileSync('count',String(n));fs.writeFileSync('ready-'+n,'1');const timer=setInterval(()=>{if(fs.existsSync('release-'+n)){clearInterval(timer);console.log('1.2.14');}},10);",
  );
  const cache = new CliCapabilityCache(),
    cancel = new AbortController();
  const first = cache.discover(cli, root, cancel.signal),
    rejected = assert.rejects(first, /取消/);
  await until(() => fs.existsSync(path.join(root, "ready-1")));
  cancel.abort();
  const retry = cache.discover(cli, root);
  try {
    await until(() => fs.existsSync(path.join(root, "ready-2")));
    await rejected;
    assert.equal(cache.stats.pending, 1);
    assert.equal(cache.stats.consumers, 1);
    fs.writeFileSync(path.join(root, "release-2"), "1");
    assert.equal((await retry).version, "1.2.14");
    assert.equal(cache.stats.pending, 0);
    assert.equal(cache.stats.entries, 1);
  } finally {
    fs.writeFileSync(path.join(root, "release-1"), "1");
    fs.writeFileSync(path.join(root, "release-2"), "1");
    await Promise.allSettled([first, retry]);
  }
});
test("successful version wrapper leaves no ignored-stdio helper running", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process group");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('probe-pids',JSON.stringify([process.pid,child.pid]));console.log('1.2.14');process.exit(0);",
  );
  const cache = new CliCapabilityCache();
  assert.equal((await cache.discover(cli, root)).version, "1.2.14");
  const pids = JSON.parse(
    fs.readFileSync(path.join(root, "probe-pids"), "utf8"),
  );
  await until(() => pids.every(exited));
});

test("inherited stdout held outside the query group reports unconfirmed exit by deadline, never authorizes version", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { ProbeExitUnconfirmedError } = require("../out/core/operationErrors");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');fs.writeFileSync('escaped-helper',JSON.stringify({pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).trim().split(' ')[19]}));console.log('1.2.14');process.exit(0);",
  );
  const cache = new CliCapabilityCache();
  const start = performance.now(),
    query = cache.discover(cli, root);
  const rejected = assert.rejects(
    query,
    (error) => error instanceof ProbeExitUnconfirmedError,
  );
  let helper;
  try {
    await until(() => fs.existsSync(path.join(root, "escaped-helper")));
    helper = JSON.parse(
      fs.readFileSync(path.join(root, "escaped-helper"), "utf8"),
    );
    await rejected;
    assert(performance.now() - start < 1500);
    assert.equal(cache.stats.entries, 0);
    assert.equal(cache.stats.pending, 0);
    assert(!exited(helper.pid), "no claim that escaped helper was terminated");
  } finally {
    if (helper) {
      try {
        const raw = fs.readFileSync("/proc/" + helper.pid + "/stat", "utf8");
        if (
          raw
            .slice(raw.lastIndexOf(")") + 2)
            .trim()
            .split(" ")[19] === helper.start
        )
          process.kill(helper.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
      }
      await until(() => exited(helper.pid));
    }
    await query.catch(() => {});
  }
});
test("cancellation preserves an exit-unconfirmed error rather than claiming stop success", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { ProbeExitUnconfirmedError } = require("../out/core/operationErrors");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');fs.writeFileSync('escaped-helper',JSON.stringify({pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).trim().split(' ')[19]}));setInterval(()=>{},1000);",
  );
  const cache = new CliCapabilityCache(),
    cancel = new AbortController();
  const query = cache.discover(cli, root, cancel.signal),
    rejected = assert.rejects(
      query,
      (error) => error instanceof ProbeExitUnconfirmedError,
    );
  let helper;
  try {
    await until(() => fs.existsSync(path.join(root, "escaped-helper")));
    helper = JSON.parse(
      fs.readFileSync(path.join(root, "escaped-helper"), "utf8"),
    );
    const start = performance.now();
    cancel.abort();
    await rejected;
    assert(performance.now() - start < 1000);
    assert(!exited(helper.pid));
    assert.equal(cache.stats.entries, 0);
  } finally {
    if (helper) {
      try {
        const raw = fs.readFileSync("/proc/" + helper.pid + "/stat", "utf8");
        if (
          raw
            .slice(raw.lastIndexOf(")") + 2)
            .trim()
            .split(" ")[19] === helper.start
        )
          process.kill(helper.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
      }
      await until(() => exited(helper.pid));
    }
    await query.catch(() => {});
  }
});

test("Controller does not acknowledge stop success when version stdout exit remains unconfirmed", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const { ProbeExitUnconfirmedError } = require("../out/core/operationErrors");
  const { root, cli } = fixture(
    t,
    "const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');fs.writeFileSync('escaped-helper',JSON.stringify({pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).trim().split(' ')[19]}));setInterval(()=>{},1000);",
  );
  const state = { get: (_k, d) => d, update: async () => {} };
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: root },
    globalState: state,
  });
  const controller = new ConversationController(
    {
      config: () => ({
        cliPath: cli,
        defaultModel: "gemini-3.8-flash-high",
        reasoningEffort: "high",
        dangerouslySkipPermissions: false,
      }),
      workspace: () => ({ root, directories: [root] }),
      log() {},
      setPermissions: async () => {},
      terminal() {},
    },
    repo,
  );
  const messages = [];
  controller.on("message", (message) => messages.push(message));
  const send = controller.sendMessage("退出未确认时保留草稿"),
    rejected = assert.rejects(
      send,
      (error) => error instanceof ProbeExitUnconfirmedError,
    );
  let helper;
  try {
    await until(() => fs.existsSync(path.join(root, "escaped-helper")));
    helper = JSON.parse(
      fs.readFileSync(path.join(root, "escaped-helper"), "utf8"),
    );
    await assert.rejects(
      controller.abortTurn(),
      (error) => error instanceof ProbeExitUnconfirmedError,
    );
    await rejected;
    assert.equal(controller.processing, false);
    assert.equal(controller.currentSessionMeta.draft, "退出未确认时保留草稿");
    assert(
      messages.some(
        (message) =>
          message.type === "turnState" && message.state.phase === "failed",
      ),
    );
    assert(
      !messages.some(
        (message) =>
          message.type === "turnState" && message.state.phase === "aborted",
      ),
    );
  } finally {
    if (helper) {
      try {
        const raw = fs.readFileSync("/proc/" + helper.pid + "/stat", "utf8");
        if (
          raw
            .slice(raw.lastIndexOf(")") + 2)
            .trim()
            .split(" ")[19] === helper.start
        )
          process.kill(helper.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;
      }
      await until(() => exited(helper.pid));
    }
    await send.catch(() => {});
    await controller.dispose();
    cliCapabilities.clear();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
