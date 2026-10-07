const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { acquireExecutionLease } = require("../out/conversation/executionLease");
const { ConversationRepository } = require("../out/conversation/repository");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-execution-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, "test.lock") };
}
function install(lock, owner) {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
}
test("execution lease publishes complete owner and excludes second owner", (t) => {
  const { lock } = fixture(t);
  const release = acquireExecutionLease(lock);
  const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json")));
  assert.equal(owner.pid, process.pid);
  if (process.platform === "linux") assert.match(owner.identity, /:\d+$/);
  assert.throws(() => acquireExecutionLease(lock), /另一个/);
  release();
  const next = acquireExecutionLease(lock);
  release();
  assert.throws(() => acquireExecutionLease(lock), /另一个/);
  next();
});
test("PID reuse reclaims stale populated directory, retaining owner-specific fence", (t) => {
  if (process.platform !== "linux") return t.skip("Linux identity");
  const { lock } = fixture(t);
  const token = randomUUID();
  install(lock, { pid: process.pid, token, identity: "previous-boot:1" });
  const release = acquireExecutionLease(lock);
  assert.equal(fs.existsSync(lock + ".retired-" + token), true);
  assert.notEqual(
    JSON.parse(fs.readFileSync(path.join(lock, "owner.json"))).token,
    token,
  );
  // A late observer of the previous owner cannot rename the new lock over its archive.
  assert.throws(
    () => fs.renameSync(lock, lock + ".retired-" + token),
    /ENOTEMPTY|EEXIST/,
  );
  release();
});
test("release cannot delete replaced owner; corrupt and legacy locks remain intact", (t) => {
  const { root, lock } = fixture(t);
  const release = acquireExecutionLease(lock);
  fs.renameSync(lock, path.join(root, "original"));
  const token = randomUUID();
  install(lock, { pid: process.pid, token });
  release();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lock, "owner.json"))).token,
    token,
  );
  fs.rmSync(lock, { recursive: true });
  install(lock, { pid: 0, token });
  assert.throws(() => acquireExecutionLease(lock), /损坏/);
  fs.rmSync(lock, { recursive: true });
  const legacy = JSON.stringify({ pid: 2147483647, token });
  fs.writeFileSync(lock, legacy);
  assert.throws(() => acquireExecutionLease(lock), /旧版/);
  assert.equal(fs.readFileSync(lock, "utf8"), legacy);
});
test("repository nested release callbacks are idempotent", (t) => {
  const { root } = fixture(t);
  const state = { get: (_key, fallback) => fallback, update: async () => {} };
  const context = { globalStorageUri: { fsPath: root }, globalState: state };
  const a = new ConversationRepository(context),
    b = new ConversationRepository(context);
  const first = a.acquire("shared"),
    nested = a.acquire("shared");
  first();
  first();
  assert.throws(() => b.acquire("shared"), /另一个/);
  nested();
  nested();
  b.acquire("shared")();
});

for (const operation of ['writeFileSync', 'renameSync']) {
  for (const stage of ['pending', 'bind']) {
    test(`execution lease ${stage} ${operation} failure preserves prior owner and removes temporary record`, t => {
      const {lock} = fixture(t);
      const release = acquireExecutionLease(lock);
      if (stage === 'bind') release.markExecutionPending();
      const before = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
      const original = fs[operation];
      try {
        fs[operation] = function(file, ...args) {
          if (typeof file === 'string' && path.dirname(file) === lock && file.endsWith('.tmp')) {
            const error = new Error('injected execution record persistence failure');
            error.code = 'ENOSPC';
            throw error;
          }
          return original.call(this, file, ...args);
        };
        assert.throws(() => stage === 'pending' ? release.markExecutionPending() : release.bindProcess(process.pid), /persistence failure/);
      } finally {fs[operation] = original;}
      try {
        assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), before);
        assert.deepEqual(fs.readdirSync(lock), ['owner.json']);
        assert.throws(() => acquireExecutionLease(lock), /另一个/);
        release.bindProcess(process.pid);
        assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).execution.pid, process.pid);
      } finally {release();}
      acquireExecutionLease(lock)();
    });
  }
}
test("crashed host cannot reclaim bound CLI or its orphan tool group until both exit", {timeout: 10000}, async t => {
  if (process.platform !== "linux") return t.skip("Linux process groups");
  const {root, lock} = fixture(t);
  const {fork} = require("node:child_process");
  const {once} = require("node:events");
  const script = path.join(root, "host.cjs");
  fs.writeFileSync(script, `const {spawn}=require('child_process');
const {acquireExecutionLease}=require(${JSON.stringify(path.resolve("out/conversation/executionLease.js"))});
const release=acquireExecutionLease(process.argv[2]);release.markExecutionPending();
const child=spawn(process.execPath,['-e',${JSON.stringify("const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);")}],{detached:true,stdio:['ignore','pipe','ignore']});
release.bindProcess(child.pid);child.stdout.once('data',data=>process.send({pid:child.pid,tool:Number(data.toString().trim())}));
setInterval(()=>{},1000);`);
  const host = fork(script, [lock], {stdio: ["ignore", "ignore", "ignore", "ipc"]});
  let group;
  t.after(() => {if (group) {try {process.kill(-group, "SIGKILL");} catch {}} if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");});
  const [pids] = await once(host, "message");
  group = pids.pid;
  const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json")));
  assert.equal(owner.execution.pid, pids.pid);
  assert.equal(owner.execution.group, pids.pid);
  assert.match(owner.execution.identity, /:\d+$/);
  const gone = once(host, "exit"); host.kill("SIGKILL"); await gone;
  assert.throws(() => acquireExecutionLease(lock), /旧宿主已退出/);
  process.kill(pids.pid, "SIGKILL");
  const {waitForProcessGroupExit} = require("../out/core/processGroup");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await waitForProcessGroupExit(pids.pid, 30), false);
  assert.throws(() => acquireExecutionLease(lock), /旧宿主已退出/);
  process.kill(-pids.pid, "SIGKILL");
  assert.equal(await waitForProcessGroupExit(pids.pid, 1000), true);
  const recovered = acquireExecutionLease(lock);
  assert(fs.existsSync(lock + ".retired-" + owner.token));
  recovered(); group = undefined;
});

test("unbound execution intent preserves dead-host lock while prior-boot intent can retire", t => {
  const {lock} = fixture(t);
  const token = randomUUID();
  install(lock, {formatVersion: 2, pid: 2147483647, token, execution: {state: "pending"}});
  assert.throws(() => acquireExecutionLease(lock), /启动归属未确认/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"))).token, token);
  fs.rmSync(lock, {recursive: true});
  install(lock, {pid: 2147483647, token, identity: "prior-boot:1", execution: {state: "pending"}});
  if (process.platform === "linux") acquireExecutionLease(lock)();
});

test("dead legacy directory owner without execution provenance is preserved for offline audit", t => {
  if (process.platform !== "linux") return t.skip("Linux boot evidence");
  const {lock} = fixture(t);
  const token = randomUUID();
  install(lock, {pid: 2147483647, token});
  assert.throws(() => acquireExecutionLease(lock), /旧版执行锁没有CLI归属记录/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"))).token, token);
});
test("competing processes reclaim crashed owner with exactly one winner", async (t) => {
  const { lock } = fixture(t);
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const script = path.join(path.dirname(lock), "worker.cjs");
  fs.writeFileSync(
    script,
    `const {acquireExecutionLease}=require(${JSON.stringify(path.resolve("out/conversation/executionLease.js"))});
process.on('message', message=>{
 if(message==='start') {
  try {global.release=acquireExecutionLease(process.argv[2]); process.send('acquired');}
  catch(e){process.send('blocked');}
 }
 if(message==='release'){global.release?.();process.exit(0);}
});process.send('ready');`,
  );
  async function worker() {
    const child = fork(script, [lock], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    await once(child, "message");
    return child;
  }
  async function start(child) {
    const reply = once(child, "message");
    child.send("start");
    return (await reply)[0];
  }
  const original = await worker();
  assert.equal(await start(original), "acquired");
  const old = JSON.parse(fs.readFileSync(path.join(lock, "owner.json")));
  const exit = once(original, "exit");
  original.kill("SIGKILL");
  await exit;
  const competitors = await Promise.all([
    worker(),
    worker(),
    worker(),
    worker(),
  ]);
  const results = await Promise.all(competitors.map(start));
  assert.equal(results.filter((x) => x === "acquired").length, 1);
  assert.equal(results.filter((x) => x === "blocked").length, 3);
  assert.equal(fs.existsSync(lock + ".retired-" + old.token), true);
  await Promise.all(
    competitors.map(async (child) => {
      const done = once(child, "exit");
      child.send("release");
      await done;
    }),
  );
  acquireExecutionLease(lock)();
});

test('execution lease release rename failure remains observable and can retry without abandoning owner',t=>{
  const {lock}=fixture(t);const release=acquireExecutionLease(lock);release.markExecutionPending();
  const owner=fs.readFileSync(path.join(lock,'owner.json'),'utf8');const rename=fs.renameSync;const failure=Object.assign(new Error('injected release rename failure'),{code:'EIO'});
  fs.renameSync=(source,...args)=>{if(source===lock)throw failure;return rename(source,...args);};
  try {assert.throws(()=>release(),error=>error===failure);assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),owner);assert.throws(()=>acquireExecutionLease(lock),/另一个/);}
  finally {fs.renameSync=rename;}
  release();assert.equal(fs.existsSync(lock),false);const next=acquireExecutionLease(lock);next();
});

test('native repository claim and reference count survive actual release I/O failure until retry',t=>{
  const {root}=fixture(t);const state={get:(_k,d)=>d,update:async()=>{}};
  const context={globalStorageUri:{fsPath:root},globalState:state,workspaceState:state};
  const repo=new ConversationRepository(context),other=new ConversationRepository(context);
  const claim=repo.acquireExecution('native-io',true);claim.markExecutionPending();
  const rename=fs.renameSync,failure=Object.assign(new Error('injected native release rename failure'),{code:'EIO'});
  fs.renameSync=(source,destination,...args)=>{if(String(destination).includes('.released-')&&String(source).startsWith(root))throw failure;return rename(source,destination,...args);};
  try {
    assert.throws(()=>claim(),error=>error===failure);
    assert.equal(repo.hasNativeExecution('native-io'),true);
    assert.equal(repo.leases.get('native-io').count,1);
    assert.throws(()=>other.acquire('native-io'),/另一个/);
  } finally {fs.renameSync=rename;}
  claim();assert.equal(repo.hasNativeExecution('native-io'),false);assert.equal(repo.leases.has('native-io'),false);
  const next=other.acquireExecution('native-io');next();
});
test('retired release cleanup can retry without touching a subsequently published owner',t=>{
  const {lock}=fixture(t);const release=acquireExecutionLease(lock);
  const rm=fs.rmSync,failure=Object.assign(new Error('injected retired cleanup failure'),{code:'EPERM'});let retired;
  fs.rmSync=(target,...args)=>{if(String(target).startsWith(lock+'.released-')){retired=target;throw failure;}return rm(target,...args);};
  try {assert.throws(()=>release(),error=>error===failure);assert(retired&&fs.existsSync(retired));assert.equal(fs.existsSync(lock),false);}
  finally {fs.rmSync=rm;}
  const next=acquireExecutionLease(lock);const owner=fs.readFileSync(path.join(lock,'owner.json'),'utf8');
  release();assert.equal(fs.existsSync(retired),false);assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),owner);
  next();assert.equal(fs.existsSync(lock),false);
});
