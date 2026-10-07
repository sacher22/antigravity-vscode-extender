const test=require('node:test'),assert=require('node:assert/strict');
const {WebviewBridge}=require('../out/ui/webviewBridge');
test('request observation follows dedup registration, once for in-flight and completed retries',async()=>{
  const sent=[];let handled=0,observed=0,release,reentrant;
  const wait=new Promise(r=>release=r);let bridge;
  const data={command:'abortCurrentTurn',requestId:'request',sessionId:'session'};
  bridge=new WebviewBridge(async()=>{handled++;await wait;},m=>sent.push(m),()=> 'session',()=>{observed++;reentrant=bridge.receive(data);});
  const first=bridge.receive(data);await Promise.resolve();assert.equal(handled,1);assert.equal(observed,1);release();await Promise.all([first,reentrant]);
  await bridge.receive(data);assert.equal(handled,1);assert.equal(observed,1);assert.equal(sent.length,3);assert(sent.every(m=>m.type==='requestComplete'));
});
test('observation failure is contained and does not alter successful command response',async()=>{
  const sent=[];let handled=0;const bridge=new WebviewBridge(async()=>handled++,m=>sent.push(m),()=> 'session',()=>{throw Error('telemetry broken');});
  await bridge.receive({command:'abortCurrentTurn',requestId:'request',sessionId:'session'});assert.equal(handled,1);assert.equal(sent[0].type,'requestComplete');
});
