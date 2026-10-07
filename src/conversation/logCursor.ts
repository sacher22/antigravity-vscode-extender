import * as fs from "fs";
import { createHash } from "crypto";
import { NativeLogCursor } from "../core/types";

/** Bounded fingerprints at the committed complete-record boundary. */
export async function cursorFor(
  handle: fs.promises.FileHandle,
  offset: number,
): Promise<NativeLogCursor> {
  const stat = await handle.stat({ bigint: true });
  const observedSize = Number(stat.size);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > observedSize)
    throw new Error("CLI 日志已截断，原游标保留；请查看原生记录。");
  const digest = async (start: number, length: number) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length)
      throw new Error("CLI 日志正在变化，原游标保留；请稍后重试。");
    return createHash("sha256").update(buffer).digest("hex");
  };
  const sample = Math.min(256, offset);
  return {
    offset,
    observedSize,
    fileId: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
    headHash: await digest(0, sample),
    tailHash: await digest(offset - sample, sample),
  };
}
export function validateCursor(
  current: NativeLogCursor,
  prior: NativeLogCursor,
) {
  if (
    prior.fileId &&
    (current.fileId !== prior.fileId ||
      current.observedSize < prior.observedSize ||
      current.headHash !== prior.headHash ||
      current.tailHash !== prior.tailHash)
  )
    throw new Error(
      "CLI 日志已替换、截断或改写，原历史与游标保留；请查看原生记录。",
    );
}
