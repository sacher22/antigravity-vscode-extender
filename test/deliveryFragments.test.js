const test=require('node:test'),assert=require('node:assert/strict');
const {textFragments,toolBatches}=require(process.env.AGY_DELIVERY_FRAGMENTS_MODULE || '../out/conversation/deliveryFragments');
const item=(i,size)=>({tool:{stepIndex:i,name:'tool',state:'ACTIVE'},size});
test('text fragments preserve whitespace controls lone surrogates and valid pairs with bounded nonempty parts',()=>{
  for(const source of ['', ' \n\0中文🙂', 'a'.repeat(16383)+'🙂'+'b'.repeat(40000), '\uD800'+'x'.repeat(16384)+'\uDC00']){
    const chunks=[...textFragments(source)];assert.equal(chunks.join(''),source);
    for(const chunk of chunks)assert(chunk.length>0&&chunk.length<=16384);
    if(!/[\uD800-\uDBFF]x|[\uDC00-\uDFFF]$/.test(source))for(const chunk of chunks){assert(!/[\uD800-\uDBFF]$/.test(chunk));assert(!/^[\uDC00-\uDFFF]/.test(chunk));}
  }
});
test('tool fragments preserve order at 32-item and 196608-byte boundaries without serialization or input mutation',()=>{
  const items=Array.from({length:70},(_,i)=>item(i,1));const before=JSON.stringify(items);
  assert.deepEqual([...toolBatches(items)].map(batch=>batch.length),[32,32,6]);assert.equal(JSON.stringify(items),before);
  assert.deepEqual([...toolBatches([item(0,98304),item(1,98304),item(2,1)])].map(batch=>batch.map(tool=>tool.stepIndex)),[[0,1],[2]]);
  const t=item(3,1);t.tool.toJSON=()=>{throw Error('must use precomputed size');};assert.equal([...toolBatches([t])][0][0],t.tool);
  assert.deepEqual([...toolBatches([])],[]);
});
test('tool fragments reject nonpositive unsafe nonfinite or over-budget precomputed sizes',()=>{
  for(const size of [0,-1,NaN,Infinity,1.5,196609,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>[...toolBatches([item(0,size)])],RangeError);
  assert.equal([...toolBatches([item(0,196608)])][0].length,1);
});
