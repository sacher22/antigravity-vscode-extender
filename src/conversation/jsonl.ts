import * as fs from "fs";
import { FileHandle } from "fs/promises";

/** The same complete-record cursor semantics without blocking Extension Host. */
export async function readJsonlPageAsync(file: FileHandle, offset: number, pageBytes = 65536) {
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 1 || pageBytes > 8 * 1024 * 1024)
    throw new Error("无效日志页大小。");
  const size = (await file.stat()).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size)
    throw new Error("日志发生变更，无法使用旧页码；请重新打开原日志。");
  const chunks: Buffer[] = [];
  let length = 0, end = 0;
  const maxRecordBytes = 8 * 1024 * 1024;
  while (offset + length < size) {
    const bytes = Buffer.alloc(Math.min(pageBytes, size - offset - length, maxRecordBytes - length));
    const {bytesRead} = await file.read(bytes, 0, bytes.length, offset + length);
    if (!bytesRead) break;
    const part = bytes.subarray(0, bytesRead);
    chunks.push(part);
    const newline = part.lastIndexOf(10);
    if (newline >= 0) end = length + newline + 1;
    length += bytesRead;
    if (end) break;
    if (length >= maxRecordBytes)
      throw new Error("单条日志超过 8 MiB，请查看原日志；页码未推进。");
  }
  return {bytes: Buffer.concat(chunks).subarray(0, end), nextOffset: offset + end, hasMore: offset + end < size};
}

/** Byte cursors commit complete records only, including across UTF-8 boundaries. */
export function readJsonlPage(fd: number, offset: number, pageBytes = 65536) {
  const size = fs.fstatSync(fd).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size)
    throw new Error("日志发生变更，无法使用旧页码；请重新打开原日志。");
  const chunks: Buffer[] = [];
  let length = 0;
  let end = 0;
  const maxRecordBytes = 8 * 1024 * 1024;
  while (offset + length < size) {
    const bytes = Buffer.alloc(Math.min(pageBytes, size - offset - length));
    const n = fs.readSync(fd, bytes, 0, bytes.length, offset + length);
    if (!n) break;
    const part = bytes.subarray(0, n);
    chunks.push(part);
    const newline = part.lastIndexOf(10);
    if (newline >= 0) end = length + newline + 1;
    length += n;
    if (end) break;
    if (length >= maxRecordBytes)
      throw new Error("单条日志超过 8 MiB，请查看原日志；页码未推进。");
  }
  return {
    bytes: Buffer.concat(chunks).subarray(0, end),
    nextOffset: offset + end,
    hasMore: offset + end < size,
  };
}

export function publicLogRole(record: Record<string, unknown>, child = false) {
  if (record.status !== "DONE" || typeof record.content !== "string") return;
  if (record.source === "MODEL" && record.type === "PLANNER_RESPONSE")
    return "assistant" as const;
  if (
    ["USER_EXPLICIT", "USER"].includes(String(record.source)) &&
    record.type === "USER_INPUT"
  )
    return "user" as const;
  // Verified native child delegation envelope; unknown system records stay private.
  if (
    child &&
    record.source === "SYSTEM" &&
    record.type === "SYSTEM_MESSAGE" &&
    /\[Message\] timestamp=\S+ sender=[a-zA-Z0-9_-]+ priority=MESSAGE_PRIORITY_\w+ content=/.test(
      record.content,
    )
  )
    return "task" as const;
}
