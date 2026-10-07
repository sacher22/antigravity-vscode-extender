'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DetailRequestGate}=require('../out/webview/detailRequestGate');
test('detail gate synchronously deduplicates and only the exact immutable ticket can finish',()=>{
  const gate=new DetailRequestGate();gate.select('a');assert.equal(gate.pending,false);
  const first=gate.begin('a','child',0);assert(first);assert.equal(first.offset,0);assert.equal(gate.pending,true);assert.equal(gate.begin('a','child'),undefined);
  assert.equal(gate.current({...first}),false);assert.equal(gate.finish({...first}),false);assert.equal(gate.pending,true);
  assert.throws(()=>{first.agentId='forged';},TypeError);
  assert.equal(gate.current(first),true);assert.equal(gate.finish(first),true);assert.equal(gate.pending,false);assert.equal(gate.finish(first),false);
});
test('detail gate session switch releases local pending without letting old callbacks unlock new request',()=>{
  const gate=new DetailRequestGate();gate.select('a');const old=gate.begin('a','same-child');
  gate.select('b');assert.equal(gate.pending,false);assert.equal(gate.current(old),false);
  const current=gate.begin('b','same-child',65536);assert(current);
  assert.equal(gate.finish(old),false);assert.equal(gate.pending,true);assert.equal(gate.current(current),true);
  gate.select('b');assert.equal(gate.current(current),true);
  assert.equal(gate.begin('a','old-child'),undefined);assert.equal(gate.current(current),true);
  assert.equal(gate.finish(current),true);
});
test('detail gate invalidation fences unmounted callbacks and permits subsequent effect initialization',()=>{
  const gate=new DetailRequestGate();const first=gate.begin(undefined,'child');assert(first);
  gate.invalidate();assert.equal(gate.current(first),false);assert.equal(gate.finish(first),false);
  gate.select(undefined);const next=gate.begin(undefined,'child');assert(next);assert(next.token>first.token);assert.equal(gate.current(next),true);assert.equal(gate.finish(first),false);assert.equal(gate.pending,true);
});
