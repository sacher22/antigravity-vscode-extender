const test=require('node:test'),assert=require('node:assert/strict');
const {RenderReceiptLedger}=require('../out/ui/renderReceiptLedger');
const identity=(extra={})=>({viewEpoch:1,sessionId:'session',turnId:'turn',generation:2,messageId:'message',stepIndex:3,kind:'firstText',minimumSourceLength:2,...extra});
const receipt=(probe,extra={})=>({...probe,receiptToDOMMs:2,DOMToFrameMs:12,sourceLength:2,completed:false,visible:true,...extra});
function harness(max=32,ttl=30000){const state={now:0,nonce:0};const ledger=new RenderReceiptLedger(()=>state.now,()=> 'token-'+(++state.nonce),max,ttl);return {ledger,state};}

test('render receipt is bound to exact source identity, consumes once and returns only segment timings',()=>{
  const {ledger,state}=harness(),probe=ledger.issue(identity());state.now=20;
  const measured=ledger.accept(receipt(probe,{unknown:'/private/body secret'}),1,'session',true);
  assert.deepEqual(measured,{turnId:'turn',kind:'firstText',hostPostToAckUpperBoundMs:20,receiptToDOMMs:2,DOMToFrameMs:12,sourceLength:2});
  assert(!JSON.stringify(measured).includes('secret'));
  assert.equal(ledger.accept(receipt(probe),1,'session',true),undefined);
  assert.deepEqual(ledger.stats(),{pending:0,accepted:1,rejected:1,expired:0,evicted:0});
});

for(const changed of ['token','viewEpoch','sessionId','turnId','generation','messageId','stepIndex','kind','minimumSourceLength']) test(`forged ${changed} is rejected without consuming original receipt`,()=>{
  const {ledger,state}=harness(),probe=ledger.issue(identity());state.now=20;
  const value=typeof probe[changed]==='number'?probe[changed]+1:'forged';
  assert.equal(ledger.accept(receipt(probe,{[changed]:value}),1,'session',true),undefined);
  assert.equal(ledger.stats().pending,1);
  assert(ledger.accept(receipt(probe),1,'session',true));
});

test('old page, different selected session and hidden Host cannot record visibility',()=>{
  const {ledger,state}=harness(),probe=ledger.issue(identity());state.now=20;
  for(const args of [[2,'session',true],[1,'other',true],[1,'session',false]])assert.equal(ledger.accept(receipt(probe),...args),undefined);
  assert.equal(ledger.accept(receipt(probe,{visible:false}),1,'session',true),undefined);
  assert(ledger.accept(receipt(probe),1,'session',true));
});

test('completion and length evidence plus monotonic client durations are validated strictly',()=>{
  const {ledger,state}=harness(),probe=ledger.issue(identity({kind:'completedText'}));state.now=20;
  for(const changed of [{completed:false},{completed:'true'},{sourceLength:1},{sourceLength:Infinity},{sourceLength:2.5},{receiptToDOMMs:NaN},{DOMToFrameMs:-1},{receiptToDOMMs:30001},{receiptToDOMMs:10,DOMToFrameMs:13}])
    assert.equal(ledger.accept(receipt(probe,{completed:true,...changed}),1,'session',true),undefined);
  for(const value of [null,undefined,[],1,'secret'])assert.equal(ledger.accept(value,1,'session',true),undefined);
  assert(ledger.accept(receipt(probe,{completed:true}),1,'session',true));
});

test('pending receipts have count/TTL bounds and clear resets metadata/counters without timers',()=>{
  const {ledger,state}=harness(2,20),first=ledger.issue(identity());state.now=1;ledger.issue(identity());state.now=2;ledger.issue(identity());
  assert.equal(ledger.stats().pending,2);assert.equal(ledger.stats().evicted,1);
  state.now=20;assert.equal(ledger.accept(receipt(first),1,'session',true),undefined);
  state.now=22;assert.equal(ledger.stats().pending,0);assert.equal(ledger.stats().expired,2);
  ledger.clear();assert.deepEqual(ledger.stats(),{pending:0,accepted:0,rejected:0,expired:0,evicted:0});
});

test('probe identity copies and duplicate nonce rejection protect pending evidence',()=>{
  const {ledger,state}=harness(),source=identity(),probe=ledger.issue(source),original={...probe};
  source.sessionId='changed';probe.sessionId='changed';state.now=20;
  assert(ledger.accept(receipt(original),1,'session',true));
  const fixed=new RenderReceiptLedger(()=>0,()=> 'same',2);
  fixed.issue(identity());assert.throws(()=>fixed.issue(identity()),/Duplicate/);assert.equal(fixed.stats().pending,1);
});

test('invalid constructors/identities and clocks reject measurement instead of fabricating elapsed time',()=>{
  for(const args of [[null,()=> 'token'],[()=>0,null],[()=>0,()=> 'token',0],[()=>0,()=> 'token',1025],[()=>0,()=> 'token',2,NaN],[()=>0,()=> 'token',2,0]])assert.throws(()=>new RenderReceiptLedger(...args));
  const {ledger,state}=harness();
  for(const fields of [{viewEpoch:-1},{generation:0.5},{stepIndex:-2},{minimumSourceLength:0},{minimumSourceLength:50000001},{sessionId:''},{turnId:'a'.repeat(129)},{kind:'fake'}])assert.throws(()=>ledger.issue(identity(fields)));
  assert.throws(()=>ledger.issue(Object.assign([],identity())),/Invalid/);
  state.now=NaN;assert.throws(()=>ledger.issue(identity()),/clock/);state.now=10;const probe=ledger.issue(identity());
  state.now=5;assert.equal(ledger.accept(receipt(probe),1,'session',true),undefined);
  state.now=Infinity;assert.equal(ledger.accept(receipt(probe),1,'session',true),undefined);
});
