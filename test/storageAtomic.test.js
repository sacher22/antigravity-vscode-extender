const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {ConversationRepository} = require('../out/conversation/repository');

for (const operation of ['writeFile', 'rename']) test(`atomic message ${operation} failure preserves committed content, removes partial temporary file and retries dirty content`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-atomic-fault-'));
  const state = {get: (_, fallback) => fallback, update: async () => {}};
  const context = {globalStorageUri: {fsPath: root}, globalState: state};
  const repo = new ConversationRepository(context);
  const record = repo.createSession('atomic-fault', 'm', 'high');
  record.messages = [{id: 'm1', role: 'assistant', content: 'committed original', status: 'completed'}];
  repo.saveSession(record);
  await repo.flush();
  const original = fs.promises[operation];
  let attempted;
  try {
    fs.promises[operation] = async function(file, ...args) {
      if (typeof file === 'string' && file.startsWith(root + path.sep) && path.basename(path.dirname(file)) === 'messages' && file.endsWith('.tmp')) {
        attempted = file;
        if (operation === 'writeFile') await original.call(this, file, 'partial uncommitted bytes', {mode: 0o600});
        const error = new Error('injected atomic persistence failure');
        error.code = operation === 'writeFile' ? 'ENOSPC' : 'EIO';
        throw error;
      }
      return original.call(this, file, ...args);
    };
    record.messages[0].content = 'retry full new content 中文🙂';
    repo.saveSession(record, ['m1']);
    await assert.rejects(repo.flush(), /atomic persistence failure/);
  } finally {fs.promises[operation] = original;}
  try {
    assert(attempted, 'fault must hit the real message temporary file');
    assert.equal(new ConversationRepository(context).getSession(record.id).messages[0].content, 'committed original');
    assert.equal(fs.existsSync(attempted), false, 'failed uncommitted write must not accumulate temporary data');
    assert.equal(repo.writePausedFor(record.id), true);
    repo.saveSession(record, ['m1']);
    await repo.flush();
    assert.equal(repo.writePausedFor(record.id), false);
    assert.equal(new ConversationRepository(context).getSession(record.id).messages[0].content, record.messages[0].content);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('atomic message rename failure with rm cleanup failure preserves committed content and warning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-atomic-rm-fault-'));
  const state = {get: (_, fallback) => fallback, update: async () => {}};
  const context = {globalStorageUri: {fsPath: root}, globalState: state};
  const repo = new ConversationRepository(context);
  const record = repo.createSession('atomic-rm-fault', 'm', 'high');
  record.messages = [{id: 'm1', role: 'assistant', content: 'committed original', status: 'completed'}];
  repo.saveSession(record);
  await repo.flush();
  const warnings = [];
  repo.on('cleanupWarning', w => warnings.push(w));
  const origRename = fs.promises.rename;
  const origRm = fs.promises.rm;
  let attempted;
  try {
    try {
      fs.promises.rename = async function(file, ...args) {
        if (typeof file === 'string' && file.startsWith(root + path.sep) && path.basename(path.dirname(file)) === 'messages' && file.endsWith('.tmp')) {
          attempted = file;
          const error = new Error('injected atomic persistence failure');
          error.code = 'EIO';
          throw error;
        }
        return origRename.call(this, file, ...args);
      };
      fs.promises.rm = async function(file, ...args) {
        if (attempted && file === attempted) {
          const error = new Error('private cleanup error text');
          error.code = 'EPERM';
          throw error;
        }
        return origRm.call(this, file, ...args);
      };
      record.messages[0].content = 'retry full new content 中文🙂';
      repo.saveSession(record, ['m1']);
      await assert.rejects(repo.flush(), err => err.code === 'EIO' && err.message === 'injected atomic persistence failure');
    } finally {
      fs.promises.rename = origRename;
      fs.promises.rm = origRm;
    }
    assert(attempted, 'fault must hit the real message temporary file');
    assert.equal(new ConversationRepository(context).getSession(record.id).messages[0].content, 'committed original');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('private cleanup error text'), false);
    assert.equal(fs.existsSync(attempted), true, 'failed tmp still exists');
    assert.equal(repo.getSession(record.id).messages[0].content, record.messages[0].content);
    assert.equal(repo.writePausedFor(record.id), true);
    fs.unlinkSync(attempted);
    repo.saveSession(record, ['m1']);
    await repo.flush();
    assert.equal(repo.writePausedFor(record.id), false);
    assert.equal(new ConversationRepository(context).getSession(record.id).messages[0].content, record.messages[0].content);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

for (const kind of ['checkpoint', 'metadata']) test(`storage ${kind} release failure returns budget and explicitly retries retained physical lock`, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-storage-release-'));
  const context={globalStorageUri:{fsPath:root},globalState:{get:(_,v)=>v,update:async()=>{}}};
  const repo=new ConversationRepository(context), other=new ConversationRepository(context);
  const session=repo.createSession('release','m','high');await repo.flush();
  const rename=fs.renameSync;let hits=0;
  try {
    fs.renameSync=function(from,...args){if(String(from).startsWith(root+path.sep)&&String(from).endsWith('.lock')){hits++;throw Object.assign(Error('storage release EIO'),{code:'EIO'});}return rename.call(this,from,...args);};
    if(kind==='checkpoint'){session.messages=[{id:'msg',role:'assistant',content:'saved output',status:'completed'}];repo.saveSession(session);}
    else {session.draft='retained draft';repo.saveMetadata(session);}
    await assert.rejects(repo.flush(),/storage release EIO/);
    assert.equal(hits,1);assert.equal(repo.writeQueueStats.estimatedBytes,0,'finished work must return its memory budget even if lock release fails');
    assert.throws(()=>other.acquire(session.id));
    await assert.rejects(repo.flush(),/storage release EIO/,'failed retry must remain observable');
    fs.renameSync=rename;
    await repo.flush();const release=other.acquire(session.id);release();
    const restored=new ConversationRepository(context).getSession(session.id);
    if(kind==='checkpoint')assert.equal(restored.messages[0].content,'saved output');
    else assert.equal(restored.draft,'retained draft');
  } finally {fs.renameSync=rename;await repo.flush().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
});

test('storage write and physical release failures preserve both causes and retry cleanup',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-storage-dual-fault-'));
  const context={globalStorageUri:{fsPath:root},globalState:{get:(_,v)=>v,update:async()=>{}}};
  const repo=new ConversationRepository(context),session=repo.createSession('dual','m','high');await repo.flush();
  const rename=fs.renameSync,atomic=repo.atomic;
  const write=Object.assign(Error('write ENOSPC'),{code:'ENOSPC'}),cleanup=Object.assign(Error('release EIO'),{code:'EIO'});
  try {
    repo.atomic=async()=>{throw write;};fs.renameSync=function(from,...args){if(String(from).startsWith(root+path.sep)&&String(from).endsWith('.lock'))throw cleanup;return rename.call(this,from,...args);};
    session.draft='retry draft';repo.saveMetadata(session);
    await assert.rejects(repo.flush(),error=>error instanceof AggregateError&&error.errors[0]===write&&error.errors[1]===cleanup);
    assert.equal(repo.writeQueueStats.estimatedBytes,0);
    fs.renameSync=rename;repo.atomic=atomic;await repo.flush();repo.saveMetadata(session);await repo.flush();
    const other=new ConversationRepository(context),release=other.acquire(session.id);release();assert.equal(other.getSession(session.id).draft,'retry draft');
  }finally{fs.renameSync=rename;repo.atomic=atomic;await repo.flush().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
});

test('delete commit release failure retains cleanup and explicit flush allows another owner',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-delete-release-'));
  const context={globalStorageUri:{fsPath:root},globalState:{get:(_,v)=>v,update:async()=>{}}};
  const repo=new ConversationRepository(context),session=repo.createSession('delete','m','high');await repo.flush();
  const rename=fs.renameSync;
  try {
    fs.renameSync=function(from,...args){if(String(from).startsWith(root+path.sep)&&String(from).endsWith('.lock'))throw Error('delete release EIO');return rename.call(this,from,...args);};
    await assert.rejects(repo.deleteSession(session.id),/delete release EIO/);
    assert.equal(repo.getSession(session.id),undefined,'committed deletion must not fabricate restoration');
    const other=new ConversationRepository(context);assert.throws(()=>other.acquire(session.id));
    await assert.rejects(repo.flush(),/delete release EIO/);fs.renameSync=rename;
    await repo.flush();const release=other.acquire(session.id);release();assert.equal(repo.writeQueueStats.estimatedBytes,0);
  }finally{fs.renameSync=rename;await repo.flush().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
});
