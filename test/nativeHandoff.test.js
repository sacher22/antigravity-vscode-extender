const test = require('node:test');
const assert = require('node:assert/strict');
const {NativeHandoff} = require('../out/conversation/nativeHandoff');
const history = require('../out/conversation/nativeHistory');
function lease(events, overrides = {}) {
  return Object.assign(() => events.push('release'), {
    markExecutionPending() { events.push('pending'); },
    bindProcess(pid) { events.push(['bind', pid]); },
  }, overrides);
}
test('native ownership is marked before terminal and held through asynchronous close import', async () => {
  const events = []; let close, bind, complete;
  const handoff = new NativeHandoff((cli,cwd,args,onClose,onProcess) => {
    assert.equal(handoff.has('local'), true); events.push(['terminal',cli,cwd,args]); close=onClose;bind=onProcess;
  });
  handoff.launch('local',lease(events),'agy','/project',['--resume','native'],done => {events.push('close');complete=done;});
  assert.deepEqual(events.slice(0,2), ['pending',['terminal','agy','/project',['--resume','native']]]);
  bind(123);close();close();
  assert.equal(handoff.has('local'),true);
  assert.equal(events.filter(e=>e==='close').length,1);
  assert.equal(events.includes('release'),false);
  bind(456); // Terminal already closed; late PID must not persist a new owner.
  complete();complete();
  assert.equal(handoff.has('local'),false);
  assert.equal(events.filter(e=>e==='release').length,1);
  bind(456);
  assert.deepEqual(events.filter(Array.isArray).filter(e=>e[0]==='bind'),[['bind',123]]);
});
test('duplicate native launch leaves original lease held and old close cannot remove new owner', () => {
  const events=[];const closes=[];const binds=[];let firstComplete,secondComplete;
  const handoff=new NativeHandoff((_c,_w,_a,close,bind)=>{closes.push(close);binds.push(bind);});
  handoff.launch('a',lease(events),'agy','/w',[],done=>{firstComplete=done;});
  assert.throws(()=>handoff.launch('a',lease(events),'agy','/w',[],()=>{}), /此会话已在原生 CLI 中打开/);
  assert.equal(events.filter(e=>e==='pending').length,1);
  assert.equal(events.includes('release'),false);
  closes[0]();firstComplete();
  handoff.launch('a',lease(events),'agy','/w',[],done=>{secondComplete=done;});
  closes[0]();firstComplete();binds[0](777);
  assert.equal(handoff.has('a'),true);
  assert.equal(events.filter(e=>e==='release').length,1);
  assert.equal(events.some(e=>Array.isArray(e)&&e[0]==='bind'),false);
  closes[1]();secondComplete();assert.equal(handoff.has('a'),false);
});
test('native startup failure releases once and can retry; pending failure never opens terminal', () => {
  for (const stage of ['pending','terminal']) {
    const events=[];const failure=new Error(stage);let launched=0;
    const handoff=new NativeHandoff(()=>{launched++;if(stage==='terminal')throw failure;});
    const claim=lease(events,stage==='pending'?{markExecutionPending(){throw failure;}}:{});
    assert.throws(()=>handoff.launch('a',claim,'agy','/w',[],()=>{}),error=>error===failure);
    assert.equal(handoff.has('a'),false);assert.equal(events.filter(e=>e==='release').length,1);
    assert.equal(launched,stage==='terminal'?1:0);
  }
});
test('native history preserves cursor semantics and only appends unseen public message identities', async () => {
  const originalCursor=history.nativeLogCursorAsync, originalPage=history.nativeHistoryWithCursorAsync;
  const cursor={offset:123,fingerprint:'test'};
  const old={id:'old',role:'user',content:'kept'}, fresh={id:'fresh',role:'assistant',content:'imported'};
  const calls=[];
  history.nativeLogCursorAsync=async id=>{calls.push(['checkpoint',id]);return cursor;};
  history.nativeHistoryWithCursorAsync=async (...args)=>{calls.push(['page',...args]);return {messages:[old,fresh],nextOffset:456,cursor:{offset:456},hasMore:true};};
  try {
    const handoff=new NativeHandoff(()=>{}),session={id:'local',cliConversationId:'native',messages:[old]};
    assert.equal(await handoff.importHistory(session),undefined);assert.equal(calls.length,0);
    await handoff.checkpoint(session);
    assert.equal(session.nativeLogOffsets.native,123);assert.equal(session.nativeLogCursors.native,cursor);
    assert.equal(await handoff.importHistory(session),true);
    assert.deepEqual(session.messages,[old,fresh]);assert.equal(session.nativeLogOffsets.native,456);
    assert.deepEqual(calls,[['checkpoint','native'],['page','native',123,cursor]]);
    assert.equal(await handoff.importHistory({id:'blank',messages:[]}),undefined);
    await handoff.checkpoint({id:'blank',messages:[]});assert.equal(calls.length,2);
  } finally {history.nativeLogCursorAsync=originalCursor;history.nativeHistoryWithCursorAsync=originalPage;}
});

test('failed native claim release retains ownership and explicit completion can retry',()=>{
  let close,complete,attempts=0;const failure=new Error('release I/O failed');
  const handoff=new NativeHandoff((_cli,_cwd,_args,onClose)=>{close=onClose;});
  const claim=Object.assign(()=>{attempts++;if(attempts===1)throw failure;},{markExecutionPending(){},bindProcess(){}});
  handoff.launch('a',claim,'agy','/w',[],done=>{complete=done;});close();
  assert.throws(()=>complete(),error=>error===failure);
  assert.equal(handoff.has('a'),true);assert.equal(handoff.size,1);
  assert.throws(()=>handoff.launch('a',claim,'agy','/w',[],()=>{}),/此会话已在原生 CLI 中打开/);
  complete();assert.equal(handoff.has('a'),false);assert.equal(attempts,2);
  complete();assert.equal(attempts,2);
});
