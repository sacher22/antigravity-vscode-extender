const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {contentHash} = require('../out/ui/codePreviews');
const {contextItems, appendContext} = require('../out/core/contextAttachments');

const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject};};
function harness(modulePath = '../out/ui/contextAdapter') {
  const uri = file => ({fsPath: file, toString: () => 'file://' + file});
  const state = {session: {id:'one',workspaceRoot:'/project',draft:'draft',messages:[]}, prepares:0};
  const saved = [], infos = [];
  const document = (file, text='body') => ({uri:uri(file),version:3,lineCount:2,getText:()=>text});
  const mock = {
    DiagnosticSeverity: {Error:0,Warning:1,Information:2},
    languages: {getDiagnostics: () => []},
    workspace: {workspaceFolders:[{uri:uri('/project')}], openTextDocument: async value => document(value.fsPath)},
    window: {showOpenDialog: async () => undefined, showInformationMessage: message => infos.push(message)},
  };
  const original = Module._load, resolved = require.resolve(modulePath); delete require.cache[resolved];
  Module._load = function(name,...args) {return name === 'vscode' ? mock : original.call(this,name,...args);};
  let ContextAdapter; try {ContextAdapter = require(resolved).ContextAdapter;} finally {Module._load = original;}
  const adapter = new ContextAdapter(() => state.session, () => {state.prepares++; return state.session = {id:'prepared',messages:[],draft:''};}, async (sessionId, attachment) => {
    if (state.save) await state.save(sessionId,attachment);
    saved.push({sessionId,attachment});
    if (state.session?.id === sessionId) state.session.attachment = attachment;
  });
  return {adapter,state,saved,infos,mock,uri,document,items:()=>contextItems(state.session?.attachment)};
}

test('context adapter snapshots multiple files and exact selection range/version without a model request', async () => {
  const h = harness();
  try {
    h.mock.window.showOpenDialog = async () => [h.uri('/project/one.ts'),h.uri('/project/two.ts')];
    await h.adapter.request('file');
    const selection = {isEmpty:false,start:{line:4,character:2},end:{line:5,character:7}};
    const document = h.document('/project/one.ts','selected text');
    let actualRange;
    document.getText = range => {actualRange=range; return 'selected text';};
    h.mock.window.activeTextEditor = {document,selection};
    await h.adapter.request('selection');
    const items = h.items();
    assert.equal(items.length,3);
    assert.equal(items[0].uri,'file:///project/one.ts');
    assert.equal(items[0].version,3);
    assert.equal(items[0].fingerprint,contentHash('body'));
    assert.deepEqual(items[2].range,{start:{line:4,character:2},end:{line:5,character:7}});
    assert.equal(actualRange,selection);
    assert.equal(items[2].code,'selected text');
    assert.equal(h.state.prepares,0);
    assert.equal(h.saved.length,2);
    selection.start.line = 99;
    assert.equal(items[2].range.start.line,4);
  } finally {h.adapter.dispose();}
});

for (const when of ['picker','open']) for (const changed of ['session','disposed']) test(`context ${changed} while awaiting ${when} cannot modify either conversation`, async () => {
  const h = harness();
  const gate = deferred(), entered = deferred();
  const before = h.state.session;
  try {
    h.mock.window.showOpenDialog = async () => {if(when==='picker') {entered.resolve(); await gate.promise;} return [h.uri('/project/file.ts')];};
    h.mock.workspace.openTextDocument = async value => {if(when==='open') {entered.resolve(); await gate.promise;} return h.document(value.fsPath);};
    const work = h.adapter.request('file');
    const rejects = assert.rejects(work,/会话|结束|关闭/);
    await entered.promise;
    if(changed==='session') h.state.session = {id:'two',workspaceRoot:'/other',messages:[]};
    else h.adapter.dispose();
    gate.resolve();
    await rejects;
    assert.equal(h.saved.length,0);
    assert.equal(before.attachment,undefined);
    assert.equal(h.state.session.attachment,undefined);
  } finally {gate.resolve();h.adapter.dispose();}
});

test('file cancellation and second-document failure preserve attachments without partial saving; retry works', async () => {
  const h = harness();
  try {
    await h.adapter.sendCodeContext('existing','already.ts');
    const prior = h.state.session.attachment;
    await h.adapter.request('file');
    assert.equal(h.saved.length,1);
    h.mock.window.showOpenDialog = async () => [h.uri('/project/one.ts'),h.uri('/project/two.ts')];
    h.mock.workspace.openTextDocument = async value => {if(value.fsPath.endsWith('two.ts')) throw new Error('EACCES second'); return h.document(value.fsPath);};
    await assert.rejects(h.adapter.request('file'),/EACCES/);
    assert.equal(h.state.session.attachment,prior);
    assert.equal(h.saved.length,1);
    h.mock.workspace.openTextDocument = async value => h.document(value.fsPath);
    await h.adapter.request('file');
    assert.equal(h.items().length,3);
    assert.equal(h.saved.length,2);
  } finally {h.adapter.dispose();}
});

test('file read rebases on latest attachment and serialized commits retain simultaneous context additions', async () => {
  const h = harness();
  const readGate = deferred(), reading = deferred(), saveGate = deferred(), saving = deferred();
  try {
    h.mock.window.showOpenDialog = async () => [h.uri('/project/from-picker.ts')];
    h.mock.workspace.openTextDocument = async value => {reading.resolve(); await readGate.promise; return h.document(value.fsPath);};
    const files = h.adapter.request('file');
    await reading.promise;
    await h.adapter.sendCodeContext('added during read','new.ts');
    readGate.resolve();
    await files;
    assert.deepEqual(h.items().map(item => item.file),['new.ts','/project/from-picker.ts']);
    let calls=0;
    h.state.save = async () => {if(++calls===1) {saving.resolve(); await saveGate.promise;}};
    const first = h.adapter.sendCodeContext('first','first.ts');
    await saving.promise;
    const second = h.adapter.sendCodeContext('second','second.ts');
    saveGate.resolve();
    await Promise.all([first,second]);
    assert.deepEqual(h.items().map(item => item.file),['new.ts','/project/from-picker.ts','first.ts','second.ts']);
  } finally {readGate.resolve();saveGate.resolve();h.adapter.dispose();}
});

test('save failure does not poison later context commits and queued stale requests cannot reach another session', async () => {
  const h = harness();
  const gate = deferred(), entered = deferred();
  try {
    h.state.save = async () => {throw new Error('ENOSPC');};
    await assert.rejects(h.adapter.sendCodeContext('failed','failed.ts'),/ENOSPC/);
    assert.equal(h.state.session.attachment,undefined);
    delete h.state.save;
    await h.adapter.sendCodeContext('retry','retry.ts');
    assert.equal(h.items().length,1);
    h.state.save = async () => {entered.resolve(); await gate.promise;};
    const first = h.adapter.sendCodeContext('first','first.ts');
    await entered.promise;
    const second = h.adapter.sendCodeContext('second','second.ts');
    const rejects = assert.rejects(second,/会话/);
    h.state.session = {id:'two',messages:[]};
    gate.resolve();
    await first; await rejects;
    assert.equal(h.state.session.attachment,undefined);
    assert.equal(h.saved.filter(item => item.sessionId==='two').length,0);
  } finally {gate.resolve();h.adapter.dispose();}
});

test('context count/byte budgets reject entire file batch without truncation and are retryable', async () => {
  const h = harness();
  try {
    h.mock.window.showOpenDialog = async () => Array.from({length:17},(_,i)=>h.uri('/project/'+i+'.ts'));
    await assert.rejects(h.adapter.request('file'),/16/);
    assert.equal(h.saved.length,0);
    h.mock.window.showOpenDialog = async () => [h.uri('/project/large.ts')];
    h.mock.workspace.openTextDocument = async value => h.document(value.fsPath,'a'.repeat(1024*1024));
    await assert.rejects(h.adapter.request('file'),/1 MiB|字节/);
    assert.equal(h.saved.length,0);
    h.mock.workspace.openTextDocument = async value => h.document(value.fsPath);
    await h.adapter.request('file');
    assert.equal(h.items()[0].code,'body');
  } finally {h.adapter.dispose();}
});

test('workspace diagnostics use path boundaries, Error/Warning only, root fallback, and 100 item limit', async () => {
  const h = harness();
  const diagnostic = (message,severity=0,line=0) => ({message,severity,range:{start:{line}}});
  try {
    h.mock.languages.getDiagnostics = () => [[h.uri('/project/one.ts'),[diagnostic('error'),diagnostic('warning',1,2),diagnostic('info',2)]],[h.uri('/project-other/no.ts'),[diagnostic('sibling must not leak')]]];
    await h.adapter.request('problems');
    const code = h.items()[0].code;
    assert.match(code,/Line 1: \[Error\] error/);
    assert.match(code,/Line 3: \[Warning\] warning/);
    assert(!code.includes('sibling'));assert(!code.includes('[Information]'));
    h.mock.languages.getDiagnostics = () => [[h.uri('/project/one.ts'),Array.from({length:105},(_,i)=>diagnostic('diagnostic-'+i))]];
    await h.adapter.request('problems');
    const last = h.items().at(-1).code;
    assert.equal((last.match(/\[Error\]/g)||[]).length,100);
    assert.match(last,/省略 5/);
    h.mock.languages.getDiagnostics = () => [];
    await h.adapter.request('problems');
    assert.equal(h.infos.length,1);
  } finally {h.adapter.dispose();}
});

test('oversized diagnostics reject visibly before saving; selection errors and prepare entry remain usable', async () => {
  const h = harness();
  try {
    await assert.rejects(h.adapter.request('selection'),/选择/);
    h.mock.languages.getDiagnostics = () => [[h.uri('/project/one.ts'),[{severity:0,range:{start:{line:0}},message:'a'.repeat(1024*1024+1)}]]];
    await assert.rejects(h.adapter.request('problems'),/1 MiB|字节/);
    assert.equal(h.saved.length,0);
    h.state.session = undefined;
    await h.adapter.sendCodeContext('code','file.ts');
    assert.equal(h.state.prepares,1);
    assert.equal(h.saved[0].sessionId,'prepared');
    h.adapter.dispose();
    await assert.rejects(h.adapter.sendCodeContext('late'),/结束|关闭/);
  } finally {h.adapter.dispose();}
});

test('slow context commits have a 16 item queue limit and recover capacity after draining', async () => {
  const h = harness(), gate = deferred(), entered = deferred();
  try {
    let calls=0;
    h.state.save = async () => {if(++calls === 1) {entered.resolve(); await gate.promise;}};
    const pending = [h.adapter.sendCodeContext('body','0.ts')];
    await entered.promise;
    for(let i=1;i<16;i++) pending.push(h.adapter.sendCodeContext('body',i+'.ts'));
    await assert.rejects(h.adapter.sendCodeContext('overflow','overflow.ts'),/队列|16/);
    assert.equal(h.saved.length,0);
    gate.resolve();
    await Promise.all(pending);
    assert.equal(h.saved.length,16);
    assert.equal(h.items().length,16);
    h.state.session.attachment=undefined;
    await h.adapter.sendCodeContext('after drain','recovered.ts');
    assert.equal(h.items()[0].file,'recovered.ts');
  } finally {gate.resolve();h.adapter.dispose();}
});

test('file staging stops reads at count and byte limits instead of retaining the whole picker batch', async () => {
  const h = harness();
  try {
    let reads=0;
    h.mock.window.showOpenDialog = async () => Array.from({length:200},(_,i)=>h.uri('/project/'+i+'.ts'));
    h.mock.workspace.openTextDocument = async value => {reads++; return h.document(value.fsPath);};
    await assert.rejects(h.adapter.request('file'),/16/);
    assert.equal(reads,17);
    assert.equal(h.saved.length,0);
    reads=0;
    h.mock.workspace.openTextDocument = async value => {reads++; return h.document(value.fsPath,'a'.repeat(1024*1024+1));};
    await assert.rejects(h.adapter.request('file'),/1 MiB|字节/);
    assert.equal(reads,1);
    assert.equal(h.saved.length,0);
  } finally {h.adapter.dispose();}
});
