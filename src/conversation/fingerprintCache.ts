import { createHash } from "crypto";

/** Bounded deduplication hints, never a source of transcript/tool content. */
export class FingerprintCache {
  private entries = new Map<string, { digest: string; bytes: number }>();
  private bytes = 0;
  private evictions = 0;
  constructor(
    readonly maxEntries = 4096,
    readonly maxBytes = 2 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new Error("Invalid fingerprint cache budget");
  }
  get size() {
    return this.entries.size;
  }
  get snapshot() {
    return {
      entries: this.size,
      estimatedBytes: this.bytes,
      evictions: this.evictions,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    };
  }
  keys() {
    return this.entries.keys();
  }
  delete(key: string) {
    const previous = this.entries.get(key);
    if (!previous) return false;
    this.bytes -= previous.bytes;
    return this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  /** One hash per candidate; oversized keys are safely left uncached. */
  matchesAndRemember(key: string, value: string): boolean {
    return this.matchesDigestAndRemember(key, fingerprint(value));
  }
  matchesDigestAndRemember(key: string, digest: string): boolean {
    const equal = this.entries.get(key)?.digest === digest;
    this.delete(key);
    const bytes = (key.length + digest.length) * 2;
    if (!this.maxEntries || bytes > this.maxBytes) return false;
    this.entries.set(key, { digest, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
      this.evictions++;
    }
    return equal;
  }
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
