const test=require('node:test'),assert=require('node:assert/strict');
const {TurnDelivery}=require(process.env.AGY_TURN_DELIVERY_MODULE || '../out/conversation/turnDelivery');
const state=(extra={})=>({turnId:'turn',sessionId:'session',generation:3,phase:'tool',startedAt:0,...extra});
const tool=(index,extra={})=>({stepIndex:index,name:'tool-'+index,state:'ACTIVE',output:'preview',...extra});
function harness(onEmit){
  const queued=new Map(),cancelled=[],sent=[];let next=0,current=true;
  const delivery=new TurnDelivery(message=>{sent.push(message);onEmit?.(message,delivery);},()=>3,()=>current,
    callback=>{const id=next++;queued.set(id,callback);return id;},id=>{cancelled.push(id);queued.delete(id);});
  return {delivery,queued,cancelled,sent,stale:()=>current=false,fire:()=>{const entries=[...queued];queued.clear();for(const [,callback]of entries)callback();}};
}
test('one timer coalesces same text/tool index and flushes text state tools in original order with first zero timestamp',()=>{
  const h=harness();h.delivery.appendText(2,'a',0);h.delivery.appendText(2,'b',5);h.delivery.appendText(4,'c',6);
  h.delivery.replaceTool(tool(7));h.delivery.replaceTool(tool(7,{output:'latest',state:'DONE'}));
  const s=state();h.delivery.deferState(s);s.detail='external mutation';
  h.delivery.deferState(state({detail:'latest tool'}));
  assert.equal(h.queued.size,1);assert.equal(h.delivery.stats().timerPending,true);
  h.fire();assert.deepEqual(h.sent.map(m=>m.type),['streamDelta','streamDelta','turnState','toolUpdates']);
  assert.equal(h.sent[0].delta,'ab');assert.equal(h.sent[0].receivedAt,0);
  assert.equal(h.sent[1].stepIndex,4);assert.equal(h.sent[2].state.detail,'latest tool');
  assert.deepEqual(h.sent[3].tools,[tool(7,{output:'latest',state:'DONE'})]);assert.equal(h.sent[3].generation,3);
  assert.equal(h.delivery.stats().textBlocks,0);assert.equal(h.delivery.stats().toolUpdates,0);assert.equal(h.delivery.stats().timerPending,false);
});
test('large text fragments preserve all source and surrogate pairs within 16384 code units',()=>{
  const h=harness();const source='a'.repeat(16383)+'🙂'+'b'.repeat(100000)+'\n\0中文';
  h.delivery.appendText(2,source,12);h.delivery.flush();
  const messages=h.sent.filter(m=>m.type==='streamDelta');assert(messages.length>1);
  assert.equal(messages.map(m=>m.delta).join(''),source);
  for(const m of messages){assert(m.delta.length<=16384);assert.equal(m.receivedAt,12);assert(!/[\uD800-\uDBFF]$/.test(m.delta));assert(!/^[\uDC00-\uDFFF]/.test(m.delta));}
});
test('tool batching obeys count and conservative byte limits without empty batches',()=>{
  const h=harness();for(let i=0;i<70;i++)h.delivery.replaceTool(tool(i));h.delivery.flush();
  assert.deepEqual(h.sent.map(m=>m.tools.length),[32,32,6]);
  const j=harness();for(let i=0;i<5;i++)j.delivery.replaceTool(tool(i,{output:'x'.repeat(25000)}));j.delivery.flush();
  assert.deepEqual(j.sent.map(m=>m.tools.length),[2,2,1]);
  for(const message of j.sent)assert(message.tools.reduce((sum,t)=>sum+JSON.stringify(t).length*3,0)<=196608);
});
test('oversized singleton is rejected before dropping an already queued valid tool',()=>{
  const h=harness();h.delivery.replaceTool(tool(1));
  assert.throws(()=>h.delivery.replaceTool(tool(2,{output:'x'.repeat(70000)})));
  h.delivery.flush();assert.deepEqual(h.sent.map(m=>m.tools.map(t=>t.stepIndex)),[[1]]);
});
test('flush snapshots pending before callbacks so reentrant text tools and state survive for next timer',()=>{
  let entered=false;const h=harness((message,delivery)=>{
    if(message.type==='streamDelta'&&!entered){entered=true;delivery.appendText(9,'new',20);delivery.replaceTool(tool(9));delivery.deferState(state({detail:'reentrant'}));}
  });
  h.delivery.appendText(2,'old',10);h.delivery.replaceTool(tool(2));h.delivery.deferState(state({detail:'old'}));h.delivery.flush();
  assert.deepEqual(h.sent.map(m=>m.type),['streamDelta','turnState','toolUpdates']);assert.equal(h.sent[2].tools[0].stepIndex,2);
  assert.equal(h.queued.size,1);h.fire();assert.equal(h.sent[3].delta,'new');assert.equal(h.sent[4].state.detail,'reentrant');assert.equal(h.sent[5].tools[0].stepIndex,9);
});
test('clearState preserves other work; dispose cancels zero handle and late/stale callbacks cannot emit',()=>{
  const h=harness();h.delivery.appendText(2,'body',1);h.delivery.deferState(state());h.delivery.clearState();h.delivery.flush();
  assert.deepEqual(h.sent.map(m=>m.type),['streamDelta']);assert(h.cancelled.includes(0));
  const j=harness();j.delivery.appendText(2,'stale',1);const callback=j.queued.get(0);j.stale();callback();
  assert.equal(j.sent.length,0);j.delivery.appendText(2,'later',1);assert.equal(j.delivery.stats().textBlocks,0);
  const k=harness();k.delivery.appendText(2,'disposed',1);const late=k.queued.get(0);k.delivery.dispose();k.delivery.dispose();late();
  k.delivery.appendText(2,'after',1);k.delivery.replaceTool(tool(1));k.delivery.deferState(state());
  assert.equal(k.sent.length,0);assert.equal(k.queued.size,0);assert(k.cancelled.includes(0));assert.equal(k.delivery.stats().closed,true);
});

test('precomputed preview size is reused and cancelled callbacks cannot flush a new pending group',()=>{
  const h=harness();const preview=tool(1);preview.toJSON=()=>{throw Error('duplicate serialization');};
  h.delivery.replaceTool(preview,100);h.delivery.flush();assert.equal(h.sent[0].tools[0],preview);
  h.delivery.appendText(2,'first',1);const old=h.queued.values().next().value;h.delivery.flush();
  h.delivery.appendText(2,'new group',2);old();assert.equal(h.sent.length,2);assert.equal(h.queued.size,1);
  h.fire();assert.equal(h.sent[2].delta,'new group');
});
test('synchronous emit failures remain observable and disposing from an emit suppresses remaining stale fragments',()=>{
  const h=harness(()=>{throw Error('transport failed');});h.delivery.appendText(2,'body',1);
  assert.throws(()=>h.delivery.flush(),/transport failed/);assert.equal(h.delivery.stats().timerPending,false);
  const j=harness((message,delivery)=>{if(message.type==='streamDelta')delivery.dispose();});
  j.delivery.appendText(2,'x'.repeat(70000),1);j.delivery.replaceTool(tool(1));j.delivery.flush();
  assert.equal(j.sent.length,1);assert.equal(j.delivery.stats().closed,true);assert.equal(j.queued.size,0);
});
