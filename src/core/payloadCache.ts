/** Bounded optional payload hints; never owns authoritative execution/persistence state. */
export class PayloadCache<V> {
  private entries = new Map<string, { value: V; bytes: number }>();
  private bytes = 0;
  private evictions = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly estimate: (value: V) => number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new Error("Invalid payload cache budget");
  }
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: V): void {
    const bytes = key.length * 2 + this.estimate(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid payload estimate");
    this.delete(key);
    if (!this.maxEntries || bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
      ++this.evictions;
    }
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
  get stats() {
    return {
      entries: this.entries.size,
      estimatedBytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
    };
  }
}
