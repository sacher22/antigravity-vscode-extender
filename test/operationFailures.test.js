const test=require('node:test');const assert=require('node:assert/strict');
const {failureText,ExecutionClaimReleaseError,combineOperationFailures}=require('../out/core/operationFailures');
test('operation failure composition preserves original error identity, order and cause',()=>{
  const original=new Error('send failed'),cleanup=new ExecutionClaimReleaseError(new Error('release failed'));
  const combined=combineOperationFailures(original,cleanup);assert(combined instanceof AggregateError);assert.deepEqual(combined.errors,[original,cleanup]);assert.equal(combined.cause,original);assert(combined.message.includes('send failed'));assert(combined.message.includes('release failed'));
  assert.equal(combineOperationFailures(original,undefined),original);assert.equal(combineOperationFailures(undefined,cleanup),cleanup);assert.equal(combineOperationFailures(original,original),original);
});
test('failure text is bounded, does not serialize and contains throwing conversion',()=>{
  assert.equal(failureText(new Error('x'.repeat(4096))).length,2048);
  const broken={toString(){throw new Error('conversion fails');},toJSON(){throw new Error('must not serialize');}};
  assert.equal(failureText(broken),'未知错误');const error=combineOperationFailures(undefined,broken);assert.equal(error.cause,broken);assert.equal(error.message,'未知错误');
  const getter=Object.create(Error.prototype);Object.defineProperty(getter,'message',{get(){throw Error('getter fails');}});assert.equal(failureText(getter),'未知错误');
  assert.equal(combineOperationFailures('x'.repeat(3000),'y'.repeat(3000)).message.length,4097);
});
test('claim release error distinguishes retained ownership without claiming unconfirmed process exit',()=>{
  const cause=Object.assign(new Error('I/O failed'),{code:'EIO'});const error=new ExecutionClaimReleaseError(cause);
  assert.equal(error.name,'ExecutionClaimReleaseError');assert.equal(error.cause,cause);assert(error.message.includes('执行锁释放未完成'));assert(error.message.includes('点击停止重试'));assert.equal(cause.code,'EIO');
});
