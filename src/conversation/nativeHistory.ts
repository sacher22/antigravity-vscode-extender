import * as fs from "fs";
import { cursorFor, validateCursor } from "./logCursor";
import { readJsonlPage, readJsonlPageAsync, publicLogRole } from "./jsonl";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { ChatMessage, NativeLogCursor } from "../core/types";
function logPath(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("无效 CLI 会话 ID。");
  const directory = path.join(
    os.homedir(),
    ".gemini/antigravity-cli/brain",
    id,
    ".system_generated/logs",
  );
  const file = path.join(directory, "transcript.jsonl");
  if (
    fs.existsSync(file) &&
    !fs.realpathSync(file).startsWith(path.resolve(directory) + path.sep)
  )
    throw new Error("不支持的 CLI 日志路径。");
  return file;
}
export function nativeLogSize(id: string) {
  try {
    return fs.statSync(logPath(id)).size;
  } catch {
    return 0;
  }
}
export function nativeHistory(
  id: string,
  offset = 0,
): { messages: ChatMessage[]; nextOffset: number; hasMore: boolean } {
  const file = logPath(id);
  if (!fs.existsSync(file))
    return { messages: [], nextOffset: offset, hasMore: false };
  const fd = fs.openSync(file, "r");
  try {
    const page = readJsonlPage(fd, offset, 1024 * 1024);
    return projectNativePage(id, offset, page);
  } finally {
    fs.closeSync(fd);
  }
}
function projectNativePage(id: string, offset: number, page: {bytes: Buffer; nextOffset: number; hasMore: boolean}) {
    const messages: ChatMessage[] = [];
    let cursor = offset;
    for (const line of page.bytes.toString("utf8").split("\n")) {
      const position = cursor;
      cursor += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        // Only verified public conversational types. Generic/tool/private reasoning is excluded.
        const role = publicLogRole(record);
        if (
          role &&
          role !== "task" &&
          record.status === "DONE" &&
          typeof record.content === "string" &&
          record.content.trim()
        ) {
          messages.push({
            id:
              "native-" +
              createHash("sha256").update(`${id}:${position}`).digest("hex"),
            role,
            content: record.content,
            timestamp: Date.parse(record.created_at) || Date.now(),
            status: "completed",
          });
        }
      } catch {
        /* Partial or unknown records are never projected. */
      }
    }
    return { messages, nextOffset: page.nextOffset, hasMore: page.hasMore };
}

async function asyncLogPath(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("无效 CLI 会话 ID。");
  const directory = path.join(os.homedir(), ".gemini/antigravity-cli/brain", id, ".system_generated/logs");
  const file = path.join(directory, "transcript.jsonl");
  try {
    if (!(await fs.promises.realpath(file)).startsWith(path.resolve(directory) + path.sep))
      throw new Error("不支持的 CLI 日志路径。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}
export async function nativeLogSizeAsync(id: string): Promise<number> {
  try {return (await fs.promises.stat(await asyncLogPath(id))).size;}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
export async function nativeHistoryAsync(id: string, offset = 0) {
  const file = await asyncLogPath(id);
  let handle;
  try {handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {messages: [] as ChatMessage[], nextOffset: offset, hasMore: false};
    throw error;
  }
  try {return projectNativePage(id, offset, await readJsonlPageAsync(handle, offset, 1024 * 1024));}
  finally {await handle.close();}
}

export async function nativeLogCursorAsync(id: string): Promise<NativeLogCursor> {
  let handle: fs.promises.FileHandle;
  try {handle = await fs.promises.open(await asyncLogPath(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {offset: 0, observedSize: 0};
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    let end = size;
    const floor = Math.max(0, size - 8 * 1024 * 1024);
    while (end > floor) {
      const start = Math.max(floor, end - 65536);
      const bytes = Buffer.alloc(end - start);
      const {bytesRead} = await handle.read(bytes, 0, bytes.length, start);
      const newline = bytes.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) return await cursorFor(handle, start + newline + 1);
      end = start;
    }
    if (floor > 0) throw new Error("CLI 日志末条超过8MiB，未建立交接游标。");
    return await cursorFor(handle, 0);
  } finally {await handle.close();}
}
export async function nativeHistoryWithCursorAsync(id: string, offset = 0, prior?: NativeLogCursor) {
  if (prior && prior.offset !== offset) throw new Error("CLI 日志游标不一致，原记录保留。");
  let handle: fs.promises.FileHandle;
  try {handle = await fs.promises.open(await asyncLogPath(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !prior?.fileId)
      return {messages: [] as ChatMessage[], nextOffset: offset, hasMore: false, cursor: {offset, observedSize: 0} as NativeLogCursor};
    throw error;
  }
  try {
    const before = await cursorFor(handle, offset);
    if (prior) validateCursor(before, prior);
    const page = await readJsonlPageAsync(handle, offset, 1024 * 1024);
    validateCursor(await cursorFor(handle, offset), before);
    const named = await fs.promises.stat(await asyncLogPath(id), {bigint: true});
    if (`${named.dev}:${named.ino}:${named.birthtimeNs}` !== before.fileId)
      throw new Error("CLI 日志在读取期间替换，原历史与游标保留。");
    return {...projectNativePage(id, offset, page), cursor: await cursorFor(handle, page.nextOffset)};
  } finally {await handle.close();}
}
