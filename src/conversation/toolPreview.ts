/** Per-message UTF-16 preview budget. Full tool originals stay in paged files. */
export const TOOL_PREVIEW_BYTES = 2 * 1024 * 1024;
export function toolPreviewLimit(count: number): number {
  return Math.min(2048, Math.floor(TOOL_PREVIEW_BYTES / (2 * Math.max(1, count))));
}
export function toolPreview(output: string, limit: number): string {
  let end = Math.min(output.length, limit);
  if (end && end < output.length && /[\uD800-\uDBFF]/.test(output[end - 1])) end--;
  // A sliced V8 string can retain the entire parsed JSONL record. Explicitly
  // encode/decode UTF-16 so a small preview owns only its small character data.
  // UTF-16 preserves code units (including pre-existing lone surrogates).
  return Buffer.from(output.slice(0, end), "utf16le").toString("utf16le");
}
