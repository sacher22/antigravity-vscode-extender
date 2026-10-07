/** Conservative retained UTF-16 payload accounting, including in-flight writes. */
export class WriteBudget {
  private entries = new Map<object, number>();
  private total = 0;
  private peak = 0;
  private pressured = false;
  constructor(private readonly changed: (paused: boolean) => void,
    readonly highBytes = 64 * 1024 * 1024, readonly lowBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(highBytes) || !Number.isSafeInteger(lowBytes) || lowBytes < 0 || highBytes <= lowBytes)
      throw new Error("Invalid write budget");
  }
  retain(owner: object, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid retained write size");
    this.total += bytes - (this.entries.get(owner) || 0);
    this.entries.set(owner, bytes);
    this.peak = Math.max(this.peak, this.total);
    this.update();
  }
  release(owner: object): void {
    this.total -= this.entries.get(owner) || 0;
    this.entries.delete(owner);
    this.update();
  }
  get snapshot() {return {estimatedBytes: this.total, peakEstimatedBytes: this.peak,
    batches: this.entries.size, paused: this.pressured, highBytes: this.highBytes, lowBytes: this.lowBytes};}
  private update() {
    const next = this.pressured ? this.total > this.lowBytes : this.total >= this.highBytes;
    if (next !== this.pressured) {this.pressured = next;this.changed(next);}
  }
}
