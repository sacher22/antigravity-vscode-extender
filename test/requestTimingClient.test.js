const test=require('node:test'),assert=require('node:assert/strict');
const {RequestClient}=require('../out/webview/requestClient');
test('browser request receipt uses its own clock once, ignores replay and does not resolve original operation',async()=>{
  let now=100000;const sent=[];const client=new RequestClient(d=>sent.push(d),()=> 'session',1000,()=>now);
  const pending=client.request({command:'abortCurrentTurn',requestTiming:{uiQueuedMs:4}});let done=false;pending.then(()=>done=true);
  assert.equal(sent[0].requestTiming.uiQueuedMs,4);now+=12;
  const observed={type:'requestObserved',probe:{token:'host-token',requestId:sent[0].requestId,viewEpoch:2}};
  client.receive(observed);assert.equal(sent.length,2);assert.equal(sent[1].command,'reportRequestLatency');assert.equal(sent[1].receipt.postToObservedUpperBoundMs,12);assert(!JSON.stringify(sent[1]).includes('100000'));
  client.receive(observed);client.receive({type:'requestObserved',probe:{...observed.probe,requestId:'unmatched'}});assert.equal(sent.length,2);await Promise.resolve();assert.equal(done,false);
  client.receive({type:'requestComplete',requestId:sent[0].requestId,command:'abortCurrentTurn'});await pending;client.dispose();
});
test('request diagnostics send failure or malformed nonce cannot fail the user operation and nontracked commands have no sampling',async()=>{
  const sent=[];const client=new RequestClient(d=>{sent.push(d);if(d.command==='reportRequestLatency')throw Error('telemetry transport fail');},()=>undefined,1000,()=>0);
  const send=client.request({command:'sendMessage',text:'private'});
  client.receive({type:'requestObserved',probe:{token:'',requestId:sent[0].requestId,viewEpoch:1}});assert.equal(sent.length,1);
  client.receive({type:'requestObserved',probe:{token:'valid',requestId:sent[0].requestId,viewEpoch:1}});assert.equal(sent.length,2);
  client.receive({type:'requestComplete',requestId:sent[0].requestId,command:'sendMessage'});await send;
  const save=client.request({command:'saveDraft',text:'private'}),packet=sent.at(-1);assert.equal(packet.requestTiming,undefined);
  client.receive({type:'requestObserved',probe:{token:'save-token',requestId:packet.requestId,viewEpoch:1}});assert.equal(sent.length,3);client.receive({type:'requestComplete',requestId:packet.requestId,command:'saveDraft'});await save;client.dispose();
});
