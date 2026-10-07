const test=require('node:test'),assert=require('node:assert/strict');
const {operationSequence}=require(process.env.AGY_OPERATION_HELPER||'./helpers/seededOperations');
test('seeded sequence preserves exact unsigned32 LCG values and independent replay',()=>{
  assert.deepEqual(operationSequence(0,4,1000),[223,762,697,484]);
  const a=operationSequence(17,120,10),b=operationSequence(17,120,10);assert.deepEqual(a,b);a[0]=99;assert.notEqual(a[0],b[0]);
  let state=0xffffffff;const expected=[];for(let i=0;i<12;i++){state=Number((BigInt(state)*1664525n+1013904223n)&0xffffffffn);expected.push(state%13);}assert.deepEqual(operationSequence(0xffffffff,12,13),expected);
  assert.deepEqual(operationSequence(0,0,1),[]);assert(operationSequence(0,10000,1000).every(x=>x>=0&&x<1000));
});
test('seeded sequence rejects invalid limits and coercion without state effects',()=>{
  for(const seed of [-1,NaN,Infinity,1.5,0x100000000,'17',undefined])assert.throws(()=>operationSequence(seed,1,10),RangeError);
  for(const count of [-1,10001,NaN,1.5,'1'])assert.throws(()=>operationSequence(0,count,10),RangeError);
  for(const actions of [0,1001,NaN,1.5,'1'])assert.throws(()=>operationSequence(0,1,actions),RangeError);
  assert.deepEqual(operationSequence(0,4,1000),[223,762,697,484]);
});
