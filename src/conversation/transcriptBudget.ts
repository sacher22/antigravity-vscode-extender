import { SessionMeta } from "../core/types";
export interface TranscriptLimits {
  maxSessions: number;
  maxBytes: number;
}
export const DEFAULT_TRANSCRIPT_LIMITS: TranscriptLimits = {
  maxSessions: 4,
  maxBytes: 32 * 1024 * 1024,
};
/** Conservative string/key payload estimate, not heap/RSS; shared strings counted again. */
export function transcriptBytes(
  session: SessionMeta,
  files: string[] = [],
): number {
  const stack: unknown[] = [session.messages, files];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number" || typeof value === "boolean")
      bytes += 8;
    else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) for (const item of value) stack.push(item);
      else
        for (const [key, item] of Object.entries(value)) {
          bytes += key.length * 2;
          stack.push(item);
        }
    }
  }
  return bytes;
}
export function validateTranscriptLimits(limits: TranscriptLimits) {
  if (
    !Number.isSafeInteger(limits.maxSessions) ||
    limits.maxSessions < 0 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 0
  )
    throw new Error("Invalid transcript cache budget");
}
