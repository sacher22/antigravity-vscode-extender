/** Prefix heights with O(log n) resize and viewport lookup. */
export class HeightIndex {
  private tree: Float64Array;
  private heights: Float64Array;
  constructor(values: number[]) {
    this.tree = new Float64Array(values.length + 1);
    this.heights = new Float64Array(values.length);
    values.forEach((height, index) => this.update(index, height));
  }
  get length() { return this.heights.length; }
  update(index: number, height: number) {
    if (index < 0 || index >= this.length || !Number.isFinite(height) || height < 1) return 0;
    const delta = height - this.heights[index];
    this.heights[index] = height;
    for (let at = index + 1; at < this.tree.length; at += at & -at) this.tree[at] += delta;
    return delta;
  }
  offset(index: number) {
    let total = 0;
    for (let at = Math.max(0, Math.min(this.length, index)); at > 0; at -= at & -at) total += this.tree[at];
    return total;
  }
  get total() { return this.offset(this.length); }
  locate(offset: number) {
    let index = 0, sum = 0;
    for (let step = 2 ** Math.floor(Math.log2(this.length || 1)); step; step >>= 1) {
      const next = index + step;
      if (next <= this.length && sum + this.tree[next] <= offset) {index = next;sum += this.tree[next];}
    }
    return Math.min(index, Math.max(0, this.length - 1));
  }
}
