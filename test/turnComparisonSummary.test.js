const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeTurn}=require('../scripts/summarize-turn.cjs');
const render=(turn,kind)=>({turn,milestone:'webview-render',kind,hostPostToAckUpperBoundMs:60,
  receiptToDOMMs:8,DOMToFrameMs:32,sourceLength:14,private:'must-not-escape'});
test('offline turn summary selects last accepted turn and returns only fresh whitelisted fields',()=>{
  const events=[{turn:'old',milestone:'accepted',elapsedMs:0},render('old','firstText'),
    {turn:'new',milestone:'accepted',elapsedMs:0},{turn:'new',milestone:'first-cli-text',elapsedMs:5000},
    {turn:'new',milestone:'first-cli-text',elapsedMs:6000},render('new','firstText'),render('new','completedText')];
  for(const e of events)Object.freeze(e);Object.freeze(events);
  const result=summarizeTurn(events);
  assert.deepEqual(result.milestones,{accepted:0,'first-cli-text':5000});assert.equal(result.turn,'new');
  assert.deepEqual(result.firstRender,{hostPostToAckUpperBoundMs:60,receiptToDOMMs:8,DOMToFrameMs:32,sourceLength:14});
  assert(!JSON.stringify(result).includes('must-not-escape'));
  result.milestones.accepted=10;result.firstRender.sourceLength=20;
  assert.equal(summarizeTurn(events).milestones.accepted,0);assert.equal(summarizeTurn(events).firstRender.sourceLength,14);
});
test('offline summary rejects malformed dimensions and never coerces measurements or invents missing times',()=>{
  for(const value of [null,{},'[]',new Array(513)])assert.throws(()=>summarizeTurn(value),/Malformed diagnostic events/);
  assert.equal(summarizeTurn([null,1,[],{turn:[],milestone:'accepted'},{turn:'',milestone:'accepted'}]),null);
  const good={turn:'new',milestone:'accepted',elapsedMs:0};
  const invalid=[NaN,Infinity,-1,'0',[],null,{},3600001];
  const r=summarizeTurn([good,...invalid.map(elapsedMs=>({turn:'new',milestone:'first-cli-text',elapsedMs})),
    {turn:'new',milestone:'__proto__',elapsedMs:0},...invalid.map(x=>({...render('new','firstText'),receiptToDOMMs:x}))]);
  assert.deepEqual(r.milestones,{accepted:0});assert.equal(r.firstRender,null);assert.equal(r.completedRender,null);
  for(const sourceLength of [0,-1,1.5,'1',50000001])assert.equal(summarizeTurn([good,{...render('new','firstText'),sourceLength}]).firstRender,null);
  assert.equal(summarizeTurn([good,{...render('new','firstText'),DOMToFrameMs:60001}]).firstRender,null);
});
