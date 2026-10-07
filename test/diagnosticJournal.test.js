const test = require("node:test");
const assert = require("node:assert/strict");
const {DiagnosticJournal} = require("../out/conversation/diagnosticJournal");

test("diagnostic journal bounds milestones and uses scoped pseudonyms without arbitrary text", () => {
  const journal = new DiagnosticJournal();
  const secretId = "/private/project opaque-secret 中文";
  journal.record(secretId, "opaque-secret", 1);
  journal.record(secretId, "accepted", NaN);
  journal.record(secretId, "accepted", -1);
  assert.equal(journal.snapshot().events.length, 0);
  for (let i = 0; i < 20000; i++) journal.record(secretId, "accepted", i + 0.123456);
  const snapshot = journal.snapshot();
  assert.equal(snapshot.events.length, 512);
  assert.equal(snapshot.discarded, 19488);
  assert(snapshot.estimatedEventBytes <= snapshot.maxEventBytes);
  assert.equal(snapshot.events.at(-1).elapsedMs, 19999.123);
  assert(!JSON.stringify(snapshot).includes(secretId));
  assert(!JSON.stringify(snapshot).includes("opaque-secret"));
  assert.equal(new Set(snapshot.events.map(event => event.turn)).size, 1);
  assert.notEqual(new DiagnosticJournal().pseudonym(secretId), journal.pseudonym(secretId));
  snapshot.events[0].milestone = "mutated";
  assert.equal(journal.snapshot().events[0].milestone, "accepted");
  journal.clear();
  assert.equal(journal.snapshot().events.length, 0);
  assert.equal(journal.snapshot().discarded, 0);
  assert.equal(journal.snapshot().estimatedEventBytes, 0);
});

test('render journal stores only validated source timing segments with scoped turn pseudonyms', () => {
  const journal=new DiagnosticJournal();
  const measured={turnId:'/private/opaque-id',kind:'firstText',hostPostToAckUpperBoundMs:50,receiptToDOMMs:10,DOMToFrameMs:32,sourceLength:100,body:'private-body',path:'/private/file'};
  journal.record(measured.turnId,'first-cli-text',40);
  journal.recordRender(measured);
  const snapshot=journal.snapshot(),entry=snapshot.events[1];
  assert.equal(snapshot.schemaVersion,3);assert.equal(entry.milestone,'webview-render');
  assert.equal(snapshot.events[0].turn,entry.turn);
  assert.equal(entry.hostPostToAckUpperBoundMs,50);
  assert(!JSON.stringify(snapshot).includes('private'));assert(!JSON.stringify(snapshot).includes('body'));
  for(const change of [{kind:'fake'},{turnId:''},{sourceLength:0},{receiptToDOMMs:NaN},{DOMToFrameMs:-1},{hostPostToAckUpperBoundMs:20}])journal.recordRender({...measured,...change});
  assert.equal(journal.snapshot().events.length,2);
  snapshot.events[1].sourceLength=1;assert.equal(journal.snapshot().events[1].sourceLength,100);
  for(let i=0;i<2000;i++)journal.recordRender(measured);
  assert.equal(journal.snapshot().events.length,512);assert(journal.snapshot().estimatedEventBytes <= 256*1024);
});


test('request boundaries and accepted turns correlate without raw identity or message payload',()=>{
  const journal=new DiagnosticJournal();
  journal.recordRequest({requestId:'private-request',sessionId:'/private/project',turnId:'private-turn',command:'abortCurrentTurn',uiQueuedMs:3,postToObservedUpperBoundMs:12,hostReceiptToReportMs:9,body:'secret'});
  journal.record('private-turn','accepted',0,'private-request');
  const snapshot=journal.snapshot();assert.equal(snapshot.events[0].request,snapshot.events[1].request);assert.equal(snapshot.events[0].turn,snapshot.events[1].turn);
  assert.equal(snapshot.events[0].milestone,'request-boundary');assert.equal(snapshot.events[0].postToObservedUpperBoundMs,12);assert(!JSON.stringify(snapshot.events).includes('private'));assert(!JSON.stringify(snapshot.events).includes('secret'));
  journal.recordRequest({requestId:'x',command:'openResource',uiQueuedMs:0,postToObservedUpperBoundMs:0,hostReceiptToReportMs:0});assert.equal(journal.snapshot().events.length,2);
});
