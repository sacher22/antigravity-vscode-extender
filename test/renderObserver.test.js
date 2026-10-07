const test=require('node:test'),assert=require('node:assert/strict');
const {RenderObserver}=require('../out/webview/renderObserver');
const probe=(extra={})=>({token:'token',viewEpoch:1,sessionId:'session',turnId:'turn',generation:1,messageId:'message',stepIndex:2,kind:'firstText',minimumSourceLength:3,...extra});
function harness(){
  const state={now:0,session:'session'},queued=new Map(),cancelled=[],sent=[];let next=0;
  const observer=new RenderObserver(receipt=>sent.push(receipt),()=>state.session,()=>state.now,
    callback=>{queued.set(++next,callback);return next;},id=>{cancelled.push(id);queued.delete(id);},element=>element.visible && element.isConnected);
  observer.selectSession('session');
  const element={textContent:'actual rendered text',visible:true,isConnected:true};
  const frame=now=>{state.now=now;const entries=[...queued.entries()];queued.clear();for(const [,callback] of entries)callback(now);};
  return {observer,state,queued,cancelled,sent,element,frame};
}

test('observer acknowledges the exact source block after DOM update and two frame opportunities',()=>{
  const h=harness();h.observer.receive(probe({extra:'/private/body'}));h.state.now=2;
  h.observer.domUpdated('unrelated',2,3,false,h.element);assert.equal(h.queued.size,0);
  h.observer.domUpdated('message',3,3,false,h.element);assert.equal(h.queued.size,0);
  h.observer.domUpdated('message',2,2,false,h.element);assert.equal(h.queued.size,0);
  h.observer.domUpdated('message',2,3,false,h.element);assert.equal(h.queued.size,1);
  h.frame(10);assert.equal(h.sent.length,0);assert.equal(h.queued.size,1);
  // A later delta must not overwrite the first matching DOM timestamp.
  h.state.now=12;h.observer.domUpdated('message',2,5,false,h.element);
  h.frame(20);assert.equal(h.sent.length,1);assert.equal(h.sent[0].receiptToDOMMs,2);assert.equal(h.sent[0].DOMToFrameMs,18);
  assert.equal(h.sent[0].sourceLength,5);assert(!JSON.stringify(h.sent[0]).includes('private'));
  h.observer.retryVisible();assert.equal(h.queued.size,0);assert.equal(h.observer.stats().pending,0);
});

test('completed-text requires terminal rendering and never acknowledges an empty or disconnected target',()=>{
  const h=harness();h.observer.receive(probe({kind:'completedText'}));h.state.now=2;
  h.observer.domUpdated('message',2,3,false,h.element);assert.equal(h.queued.size,0);
  h.element.textContent='';h.observer.domUpdated('message',2,3,true,h.element);assert.equal(h.queued.size,0);
  h.element.textContent='body';h.element.isConnected=false;h.observer.domUpdated('message',2,3,true,h.element);assert.equal(h.queued.size,0);
  h.element.isConnected=true;h.observer.domUpdated('message',2,3,true,h.element);
  h.frame(10);h.frame(20);assert.equal(h.sent[0].completed,true);
});

test('hidden/offscreen samples wait for a user visibility/scroll event without a recurring RAF loop',()=>{
  const h=harness();h.observer.receive(probe());h.state.now=2;h.element.visible=false;
  h.observer.domUpdated('message',2,3,false,h.element);assert.equal(h.queued.size,0);
  h.observer.retryVisible();assert.equal(h.queued.size,0);
  h.element.visible=true;h.observer.retryVisible();h.frame(10);
  h.element.visible=false;h.frame(20);assert.equal(h.sent.length,0);assert.equal(h.queued.size,0);
  h.element.visible=true;h.observer.retryVisible();h.frame(30);h.frame(40);assert.equal(h.sent.length,1);
});

test('session change/clear cancels pending callbacks and disposed transport cannot break rendering',()=>{
  const h=harness();h.observer.receive(probe());h.state.now=2;h.observer.domUpdated('message',2,3,false,h.element);
  h.state.session='other';h.observer.selectSession('other');assert.equal(h.queued.size,0);assert.equal(h.observer.stats().pending,0);
  h.frame(20);assert.equal(h.sent.length,0);
  h.observer.receive(probe());assert.equal(h.observer.stats().pending,0);
  h.state.session='session';h.observer.selectSession('session');h.observer.receive(probe());h.observer.domUpdated('message',2,3,false,h.element);
  h.observer.clear();assert.equal(h.queued.size,0);h.frame(40);assert.equal(h.sent.length,0);
  const bad=new RenderObserver(()=>{throw Error('closed');},()=> 'session',()=> h.state.now,callback=>{h.queued.set(99,callback);return 99;},()=>{},()=>true);
  bad.receive(probe());bad.domUpdated('message',2,3,false,h.element);h.frame(50);assert.doesNotThrow(()=>h.frame(60));
});

test('observer bounds pending metadata, expires without intervals and protects probe copies',()=>{
  const h=harness(),input=probe();h.observer.receive(input);input.messageId='mutated';
  h.state.now=2;h.observer.domUpdated('message',2,3,false,h.element);h.frame(10);h.frame(20);assert.equal(h.sent.length,1);
  for(let i=0;i<100;i++)h.observer.receive(probe({token:'token-'+i}));
  assert.equal(h.observer.stats().pending,32);h.state.now=30020;assert.equal(h.observer.stats().pending,0);assert.equal(h.queued.size,0);
});
