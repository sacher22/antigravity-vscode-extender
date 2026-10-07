import type { ContextAttachment, SessionMeta } from "./types";
import {
  IMAGE_MAX_COUNT,
  IMAGE_TOTAL_BYTES,
  IMAGE_THUMBNAIL_CHARS,
} from "./imageAttachments";
export const CONTEXT_BYTES = 1024 * 1024;
export function contextItems(
  attachment?: SessionMeta["attachment"],
): ContextAttachment[] {
  return attachment
    ? (attachment.items || [{ ...attachment }]).map((item) => ({ ...item }))
    : [];
}
export function combineContext(
  items: ContextAttachment[],
): SessionMeta["attachment"] {
  if (!items.length) return undefined;
  if (items.length > 16)
    throw new Error("最多添加 16 份上下文，请先移除不需要的内容。");
  const images = items.flatMap((item) => (item?.image ? [item.image] : []));
  if (
    images.length > IMAGE_MAX_COUNT ||
    images.reduce((sum, image) => sum + image.bytes, 0) > IMAGE_TOTAL_BYTES
  )
    throw new Error("每条消息最多 4 张图片，总计不超过 10 MiB。");
  for (const image of images)
    if (
      typeof image.file !== "string" ||
      image.file.length > 8192 ||
      !Number.isSafeInteger(image.bytes) ||
      image.bytes <= 0 ||
      typeof image.thumbnail !== "string" ||
      image.thumbnail.length > IMAGE_THUMBNAIL_CHARS ||
      !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(
        image.thumbnail,
      )
    )
      throw new Error("无效的图片附件。");

  for (const item of items) {
    if (!item || typeof item.code !== "string")
      throw new Error("无效的附件内容。");
    for (const key of ["uri", "file", "title"] as const)
      if (
        item[key] !== undefined &&
        (typeof item[key] !== "string" || item[key]!.length > 8192)
      )
        throw new Error("无效的附件来源。");
    if (
      item.version !== undefined &&
      (!Number.isSafeInteger(item.version) || item.version < 0)
    )
      throw new Error("无效的附件版本。");
    if (item.range)
      for (const position of [item.range.start, item.range.end])
        if (
          !position ||
          !Number.isSafeInteger(position.line) ||
          position.line < 0 ||
          !Number.isSafeInteger(position.character) ||
          position.character < 0
        )
          throw new Error("无效的附件选区。");
  }
  const code = items
    .map(
      (item) =>
        `文件/上下文：${item.file || item.title || item.uri || "选区"}${item.range ? `（${item.range.start.line + 1}:${item.range.start.character + 1}–${item.range.end.line + 1}:${item.range.end.character + 1}）` : ""}${item.version !== undefined ? `，版本 ${item.version}` : ""}\n${item.code}`,
    )
    .join("\n\n");
  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > CONTEXT_BYTES)
    throw new Error(
      `上下文共 ${bytes} 字节，超过 1 MiB；请移除文件或选择片段，内容未截断。`,
    );
  return {
    code,
    items: items.map((item) => ({
      ...item,
      bytes: new TextEncoder().encode(item.code).byteLength,
    })),
    bytes,
    title: `${items.length} 份上下文`,
  };
}
export function appendContext(
  previous: SessionMeta["attachment"],
  next: ContextAttachment,
) {
  const items = contextItems(previous);
  const same = next.uri
    ? items.findIndex(
        (item) =>
          item.uri === next.uri &&
          JSON.stringify(item.range) === JSON.stringify(next.range),
      )
    : -1;
  if (same >= 0) items[same] = next;
  else items.push(next);
  return combineContext(items);
}
