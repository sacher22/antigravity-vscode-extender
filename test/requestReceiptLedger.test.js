const test=require('node:test'),assert=require('node:assert/strict');
const {RequestReceiptLedger}=require(process.env.AGY_REQUEST_LEDGER||'../out/ui/requestReceiptLedger');
function harness(max=2,ttl=100){let now=0,n=0;const ledger=new RequestReceiptLedger(()=>now,()=>`token-${++n}`,max,ttl);const issue=(extra={})=>ledger.issue({requestId:'request',command:'sendMessage',viewEpoch:3,sessionId:'session',uiQueuedMs:5,...extra});return {ledger,issue,time:value=>now=value};}
function receipt(probe,extra={}){return {...probe,postToObservedUpperBoundMs:8,...extra};}
test('request receipt measures only local durations and consumes one matched nonce',()=>{
  const h=harness(),probe=h.issue({body:'secret',path:'/private',clientSentAt:999999});h.time(10);
  assert.deepEqual(Object.keys(probe).sort(),['requestId','token','viewEpoch']);
  const m=h.ledger.accept(receipt(probe),3);assert(m);assert.equal(m.requestId,'request');assert.equal(m.command,'sendMessage');assert.equal(m.sessionId,'session');assert.equal(m.uiQueuedMs,5);assert.equal(m.postToObservedUpperBoundMs,8);assert.equal(m.hostReceiptToReportMs,10);assert(!JSON.stringify(m).includes('secret'));assert(!JSON.stringify(m).includes('999999'));
});
test('request receipt mismatch, bad duration and throwing conversion cannot consume valid pending entry',()=>{
  const h=harness(),probe=h.issue();
  for(const value of [receipt(probe,{requestId:'wrong'}),receipt(probe,{viewEpoch:4}),receipt(probe,{postToObservedUpperBoundMs:NaN}),receipt(probe,{postToObservedUpperBoundMs:-1}),{get token(){throw Error('secret');}}])assert.equal(h.ledger.accept(value,3),undefined);
  assert.equal(h.ledger.stats().pending,1);assert(h.ledger.accept(receipt(probe),3));assert.equal(h.ledger.accept(receipt(probe),3),undefined);assert.equal(h.ledger.stats().accepted,1);
});
test('request receipt budgets TTL and view rebuild clear without timers',()=>{
  const h=harness(),a=h.issue(),b=h.issue({requestId:'b'}),c=h.issue({requestId:'c'});assert.equal(h.ledger.stats().pending,2);assert.equal(h.ledger.stats().evicted,1);assert.equal(h.ledger.accept(receipt(a),3),undefined);
  assert.equal(h.ledger.accept(receipt(b),4),undefined);h.time(100);assert.equal(h.ledger.accept(receipt(c),3),undefined);assert.equal(h.ledger.stats().expired,2);
  h.issue();h.ledger.clear();assert.equal(h.ledger.stats().pending,0);assert.equal(h.ledger.stats().evicted,1);
});
test('request receipt rejects invalid configuration identity and nonce collision without loss',()=>{
  for(const args of [[()=>0,()=>'',0,1],[()=>0,()=>'',1,0],[()=>0,()=>'',1,Infinity]])assert.throws(()=>new RequestReceiptLedger(...args));
  const h=harness();for(const extra of [{command:'getToolDetail'},{viewEpoch:-1},{requestId:''},{uiQueuedMs:Infinity},{sessionId:'x'.repeat(129)}])assert.throws(()=>h.issue(extra));
  const ledger=new RequestReceiptLedger(()=>0,()=> 'same');const probe=ledger.issue({requestId:'one',command:'abortCurrentTurn',viewEpoch:1,uiQueuedMs:0});assert.throws(()=>ledger.issue({requestId:'two',command:'sendMessage',viewEpoch:1,uiQueuedMs:0}));assert(ledger.accept(receipt(probe),1));
});
