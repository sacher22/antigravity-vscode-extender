const test=require('node:test'),assert=require('node:assert/strict');
const {RenderTelemetryBridge}=require('../out/ui/renderTelemetryBridge'),{RenderReceiptLedger}=require('../out/ui/renderReceiptLedger');
const state=(extra={})=>({turnId:'turn',sessionId:'session',generation:2,phase:'responding',startedAt:0,...extra});
const body=(extra={})=>({id:'message',role:'assistant',content:'',blocks:[],status:'running',...extra});
const init=(message=body(),extra={})=>({type:'initSession',session:{id:'session',messages:[]},config:{},activeTurn:{state:state(),message},...extra});
const delta=(extra={})=>({type:'streamDelta',sessionId:'session',turnId:'turn',generation:2,stepIndex:3,delta:'text',...extra});
const complete=(extra={})=>({type:'turnComplete',sessionId:'session',turnId:'turn',generation:2,messageId:'message',changes:{status:'completed'},result:{status:'SUCCESS'},...extra});
const receipt=probe=>({...probe,receiptToDOMMs:2,DOMToFrameMs:12,sourceLength:100,completed:true,visible:true});
function harness(){const state={now:0,nonce:0},recorded=[],posted=[];const ledger=new RenderReceiptLedger(()=>state.now,()=> 't-'+(++state.nonce));const bridge=new RenderTelemetryBridge(m=>recorded.push(m),(id,kind)=>posted.push({id,kind}),ledger);return {bridge,state,recorded,posted,epoch:bridge.newView()};}

test('Host bridge annotates first and completed body only, not tool output or every delta',()=>{
  const h=harness();assert.equal(h.bridge.decorate(init()).renderProbe,undefined);
  assert.equal(h.bridge.decorate({type:'toolUpdate',stepIndex:1,toolName:'tool',state:'ACTIVE'}).renderProbe,undefined);
  assert.equal(h.bridge.decorate(delta({delta:'  '})).renderProbe,undefined);
  const first=h.bridge.decorate(delta()).renderProbe;assert.equal(first.kind,'firstText');assert.equal(first.minimumSourceLength,4);
  for(let i=0;i<1000;i++)assert.equal(h.bridge.decorate(delta()).renderProbe,undefined);
  const final=h.bridge.decorate(complete()).renderProbe;assert.equal(final.kind,'completedText');assert.equal(final.stepIndex,3);
  assert.equal(h.bridge.decorate(complete()).renderProbe,undefined);
  h.state.now=20;h.bridge.accept(receipt(first),h.epoch,'session',true);h.bridge.accept(receipt(final),h.epoch,'session',true);
  assert.equal(h.recorded.length,2);assert.equal(h.posted.length,2);assert.equal(h.bridge.stats().pending,0);
});

test('restored/structured body probes have real source IDs and independent context, with bounded metadata',()=>{
  const h=harness();const live=init(body({content:'body',blocks:[{stepIndex:3,text:'body'}]}));
  const restored=h.bridge.decorate(live).renderProbe;assert.equal(restored.kind,'restoredText');assert.equal(restored.minimumSourceLength,4);
  assert.equal(h.bridge.decorate(live).renderProbe,undefined);assert.equal(h.bridge.decorate(delta()).renderProbe,undefined);
  const structured=h.bridge.decorate(complete({changes:{status:'completed',structuredOutput:true,blocks:[]}})).renderProbe;assert.equal(structured.stepIndex,-1);
  for(let i=0;i<100;i++)h.bridge.decorate(init(body({id:'m-'+i,content:'body'}),{activeTurn:{state:state({turnId:'turn-'+i}),message:body({id:'m-'+i,content:'body'})}}));
  assert(h.bridge.stats().sourceEntries<=32);assert(h.bridge.stats().restoredEntries<=32);assert(h.bridge.stats().pending<=32);
  const historical=h.bridge.decorate({type:'initSession',session:{id:'history',messages:[body({id:'old',content:'saved',status:'completed'})]},config:{}}).renderProbe;
  assert.equal(historical.kind,'restoredText');assert.equal(historical.turnId,'restored:old');
});

test('old view/hidden/disposed receipts and forged completion IDs cannot enter the journal',()=>{
  const h=harness();h.bridge.decorate(init());const first=h.bridge.decorate(delta()).renderProbe;h.state.now=20;
  h.bridge.accept(receipt(first),h.epoch,'session',false);assert.equal(h.recorded.length,0);
  assert.equal(h.bridge.decorate(complete({messageId:'wrong'})).renderProbe,undefined);
  h.bridge.newView();h.bridge.accept(receipt(first),h.epoch,'session',true);assert.equal(h.recorded.length,0);
  h.bridge.decorate(init());const next=h.bridge.decorate(delta()).renderProbe;h.bridge.hidden();h.bridge.accept(receipt(next),h.epoch+1,'session',true);assert.equal(h.recorded.length,0);
  h.bridge.clear();assert.equal(h.bridge.stats().pending,0);assert.equal(h.bridge.stats().sourceEntries,0);
});
