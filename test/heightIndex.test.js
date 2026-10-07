const test = require("node:test");
const assert = require("node:assert/strict");
const {HeightIndex} = require("../out/webview/heightIndex");
test("dynamic height prefix and viewport lookup match complete rows after randomized resizes", () => {
  const values = Array.from({length: 10000}, (_, index) => 30 + index % 17);
  const heights = new HeightIndex(values);
  for (let iteration = 0; iteration < 1000; iteration++) {
    const index = (iteration * 7919) % values.length;
    values[index] = 20 + iteration % 400;
    heights.update(index, values[index]);
    const position = (iteration * 997) % values.length;
    assert.equal(heights.offset(position), values.slice(0, position).reduce((sum, value) => sum + value, 0));
    assert.equal(heights.locate(heights.offset(position) + values[position] / 2), position);
  }
  assert.equal(heights.total, values.reduce((sum, value) => sum + value, 0));
  assert.equal(heights.locate(-1), 0);
  assert.equal(heights.locate(heights.total + 1), values.length - 1);
});
