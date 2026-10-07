const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function harness(processId, onProcess = () => {}) {
  let close, disposed = 0;
  const logs = [], terminal = {processId, show() {}};
  const mock = {window: {
    createOutputChannel: () => ({appendLine: line => logs.push(line)}),
    createTerminal: () => terminal,
    onDidCloseTerminal: callback => {close = callback; return {dispose() {disposed++;}};},
  }};
  const original = Module._load;
  const modulePath = require.resolve('../out/adapters/workspaceAdapter');
  delete require.cache[modulePath];
  Module._load = function(name, ...args) {return name === 'vscode' ? mock : original.call(this, name, ...args);};
  let Adapter;
  try {Adapter = require(modulePath).VSCodeWorkspaceAdapter;} finally {Module._load = original;}
  const adapter = new Adapter({subscriptions: []});
  let closed = 0;
  adapter.terminal('agy', '/isolated', [], () => {closed++;}, onProcess);
  return {logs, terminal, close: value => close(value), get disposed() {return disposed;}, get closed() {return closed;}};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('native terminal accepts VS Code PromiseLike process ID and binds only its own live terminal', async () => {
  const pids = [];
  const h = harness({then(resolve) {resolve(12345);}}, pid => pids.push(pid));
  h.close({});
  await flush();
  assert.deepEqual(pids, [12345]);
  assert.equal(h.closed, 0);
  h.close(h.terminal);
  assert.equal(h.closed, 1);
  assert.equal(h.disposed, 1);
});

test('native terminal close fences delayed PID callback and unavailable ID preserves pending ownership', async () => {
  let resolve;
  const pids = [];
  const h = harness(new Promise(r => {resolve = r;}), pid => pids.push(pid));
  h.close(h.terminal);
  resolve(12345);
  await flush();
  assert.deepEqual(pids, []);
  assert.equal(h.closed, 1);
  const missing = harness(Promise.reject(new Error('private native failure')));
  await flush();
  assert.equal(missing.logs.length, 1);
  assert.match(missing.logs[0], /lease remains pending/);
  assert.doesNotMatch(missing.logs[0], /private native failure/);
  assert.equal(missing.closed, 0);
});

test('native process binding failure is reported structurally without closing or releasing terminal', async () => {
  const h = harness(Promise.resolve(12345), () => {throw new Error('private storage path');});
  await flush();
  assert.equal(h.closed, 0);
  assert.equal(h.disposed, 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /lease remains pending/);
  assert.doesNotMatch(h.logs[0], /private storage path/);
});
