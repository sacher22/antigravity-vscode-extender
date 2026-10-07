const ERROR_CODES = ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"] as const;
const CODE_MATCHERS = ERROR_CODES.map(code => ({code, pattern: new RegExp(`\\b${code}\\b`)}));

/** No line buffering or raw text retention. Classification is a bounded hint. */
export class CliStderrSummary {
  private bytes = 0;
  private chunks = 0;
  private inspectedBytes = 0;
  private readonly codes = new Map<string, number>();
  static readonly inspectionBudget = 64 * 1024;
  static readonly chunkInspectionBudget = 2048;

  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.chunks++;
    const size = Math.min(chunk.length, CliStderrSummary.chunkInspectionBudget,
      CliStderrSummary.inspectionBudget - this.inspectedBytes);
    if (size <= 0) return;
    this.inspectedBytes += size;
    const prefix = chunk.subarray(0, size).toString("utf8");
    for (const {code, pattern} of CODE_MATCHERS) {
      if (pattern.test(prefix)) this.codes.set(code, (this.codes.get(code) || 0) + 1);
    }
  }
  snapshot() {
    return {
      bytes: this.bytes,
      chunks: this.chunks,
      inspectedBytes: this.inspectedBytes,
      uninspectedBytes: this.bytes - this.inspectedBytes,
      codes: Object.fromEntries(this.codes),
      classification: "bounded-prefix" as const,
    };
  }
}
