const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CommitDiagnostics}=require('../out/conversation/commitDiagnostics');
const {ConversationRepository}=require('../out/conversation/repository');
const {ConversationController}=require('../out/conversation/controller');
const {DiagnosticJournal}=require('../out/conversation/diagnosticJournal');
const state=()=>({get:(_,d)=>d,update:async()=>{}});
const context=root=>({globalStorageUri:{fsPath:root},globalState:state()});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{const start=performance.now();while(!fn()){if(performance.now()-start>10000)throw Error('commit test timeout');await delay(10);}};

test('commit correlation rejects old running/wrong-session writes, consumes terminal callback once and contains failures',()=>{
  let now=0,count=0;const c=new CommitDiagnostics(()=>now);
  c.watch('s','m','completed',()=>count++);
  c.accept({sessionId:'other',messageId:'m',status:'completed'});
  c.accept({sessionId:'s',messageId:'m',status:'running'});assert.equal(count,0);
  c.accept({sessionId:'s',messageId:'m',status:'completed'});assert.equal(count,1);
  c.accept({sessionId:'s',messageId:'m',status:'completed'});assert.equal(count,1);
  c.watch('s','m2','failed',()=>{throw Error('optional telemetry');});
  assert.doesNotThrow(()=>c.accept({sessionId:'s',messageId:'m2',status:'failed'}));assert.equal(c.stats().pending,0);
});
test('commit metadata is bounded and expires without timers; clear removes disposed callbacks',()=>{
  let now=0,count=0;const c=new CommitDiagnostics(()=>now);
  for(let i=0;i<1000;i++)c.watch('s','m'+i,'aborted',()=>count++);
  assert.equal(c.stats().pending,32);assert.equal(c.stats().evicted,968);
  now=300000;c.accept({sessionId:'s',messageId:'m999',status:'aborted'});
  assert.equal(count,0);assert.equal(c.stats().pending,0);assert.equal(c.stats().expired,32);
  c.watch('s','new','completed',()=>count++);c.clear();c.accept({sessionId:'s',messageId:'new',status:'completed'});assert.equal(count,0);
  now=NaN;c.watch('s','bad','completed',()=>count++);assert.equal(c.stats().pending,0);
});
test('repository reports committed identities only after message and metadata replacement, and retries metadata failure',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-commit-fault-'));const repo=new ConversationRepository(context(root));
  const s=repo.createSession('commit-fault','m','high');await repo.flush();const events=[];
  repo.on('messageCommitted',event=>events.push(event));const original=repo.atomic.bind(repo);
  try {
    s.messages=[{id:'message',role:'assistant',content:'private-content',status:'completed'}];
    repo.atomic=async(file,raw)=>{if(path.basename(file)==='session.json')throw Error('metadata injected failure');return original(file,raw);};
    repo.saveSession(s,['message']);await assert.rejects(repo.flush(),/metadata injected/);assert.equal(events.length,0);
    repo.atomic=original;repo.saveSession(s,['message']);await repo.flush();
    assert.deepEqual(events,[{sessionId:s.id,messageId:'message',status:'completed'}]);
    assert(!JSON.stringify(events).includes('private-content'));
    repo.on('messageCommitted',()=>{throw Error('observer failure');});
    s.messages[0].content='updated';repo.saveSession(s,['message']);await repo.flush();
    assert.equal(new ConversationRepository(context(root)).getSession(s.id).messages[0].content,'updated');
  } finally {repo.atomic=original;fs.rmSync(root,{recursive:true,force:true});}
});
test('real Controller and POSIX CLI completion precede storage milestone until actual queued save resolves',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-commit-controller-'));const repo=new ConversationRepository(context(root));
  const journal=new DiagnosticJournal();const env={config:()=>({cliPath:path.join(__dirname,'fixtures/fake-agy.js'),defaultModel:'gemini-3.8-flash-high',reasoningEffort:'high',dangerouslySkipPermissions:false}),workspace:()=>({root,directories:[root]}),log(){},setPermissions:async()=>{},terminal(){}};
  const controller=new ConversationController(env,repo,undefined,true,journal);const original=repo.atomic.bind(repo);
  let release;const blocked=new Promise(r=>release=r);let hit=false;
  repo.atomic=async(file,raw)=>{if(path.basename(file)==='session.json'&&JSON.parse(raw).lastMessageStatus==='completed'){hit=true;await blocked;}return original(file,raw);};
  try {
    await controller.sendMessage('hello');await until(()=>!controller.processing&&hit);
    assert(journal.snapshot().events.some(e=>e.milestone==='execution-ended'));
    assert(!journal.snapshot().events.some(e=>e.milestone==='storage-committed'));
    release();await repo.flush();
    const events=journal.snapshot().events;const committed=events.find(e=>e.milestone==='storage-committed');
    assert(committed);assert.equal(committed.turn,events.find(e=>e.milestone==='execution-ended').turn);
    assert(committed.elapsedMs>=events.find(e=>e.milestone==='execution-ended').elapsedMs);
    assert.equal(controller.diagnosticProcessSnapshot().commits.pending,0);
    await controller.dispose();assert.equal(repo.listenerCount('messageCommitted'),0);
  } finally {release();repo.atomic=original;await controller.dispose();await repo.flush();fs.rmSync(root,{recursive:true,force:true});}
});

test('legacy state acknowledgement keeps the submitted message status when live message changes during update',async()=>{
  let unblock,seen;const gate=new Promise(r=>unblock=r);const committed=[];
  const state={get:(_,d)=>d,update:async(key,value)=>{if(key.startsWith('antigravity.session.v3.')&&value.messages?.length){seen=value;await gate;}}};
  const repo=new ConversationRepository({globalState:state});const session=repo.createSession('legacy-commit','m','high');await repo.flush();
  repo.on('messageCommitted',event=>committed.push(event));
  session.messages=[{id:'legacy-message',role:'assistant',content:'completed body',status:'completed'}];
  repo.saveSession(session);await until(()=>!!seen);
  session.messages[0].status='failed';session.messages[0].content='later body';
  unblock();await repo.flush();
  assert.equal(seen.messages[0].status,'completed');assert.equal(seen.messages[0].content,'completed body');
  assert.deepEqual(committed,[{sessionId:session.id,messageId:'legacy-message',status:'completed'}]);
});
