function operationSequence(seed, count, actionCount) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    throw new RangeError('seed must be an integer between 0 and 4294967295');
  }
  if (!Number.isInteger(count) || count < 0 || count > 10000) {
    throw new RangeError('count must be an integer between 0 and 10000');
  }
  if (!Number.isInteger(actionCount) || actionCount < 1 || actionCount > 1000) {
    throw new RangeError('actionCount must be an integer between 1 and 1000');
  }
  let value = seed >>> 0;
  const result = [];
  for (let i = 0; i < count; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    result.push(value % actionCount);
  }
  return result;
}

module.exports = { operationSequence };
