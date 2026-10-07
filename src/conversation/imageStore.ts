import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  IMAGE_MAX_BYTES,
  IMAGE_THUMBNAIL_CHARS,
} from "../core/imageAttachments";
import type { ImageUpload, ImageAttachment } from "../core/types";
export function decodeImage(upload: ImageUpload): Buffer {
  if (
    !upload ||
    !["image/png", "image/jpeg", "image/webp"].includes(upload.mime) ||
    typeof upload.data !== "string" ||
    upload.data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.data)
  )
    throw new Error("仅支持不超过 5 MiB 的 PNG、JPEG、WebP 截图。");
  const bytes = Buffer.from(upload.data, "base64");
  const valid =
    upload.mime === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : upload.mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (
    !valid ||
    !bytes.length ||
    bytes.length > IMAGE_MAX_BYTES ||
    bytes.toString("base64") !== upload.data
  )
    throw new Error("图片格式或大小无效。");
  if (
    typeof upload.thumbnail !== "string" ||
    upload.thumbnail.length > IMAGE_THUMBNAIL_CHARS ||
    !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(
      upload.thumbnail,
    )
  )
    throw new Error("截图缩略图无效。");
  return bytes;
}
export async function storeImage(
  directory: string,
  upload: ImageUpload,
): Promise<ImageAttachment> {
  const bytes = decodeImage(upload);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries)
    if (entry.isFile())
      total += (await fs.stat(path.join(directory, entry.name))).size;
  const extension =
    upload.mime === "image/png"
      ? "png"
      : upload.mime === "image/jpeg"
        ? "jpg"
        : "webp";
  const file = path.join(
    directory,
    createHash("sha256").update(bytes).digest("hex") + "." + extension,
  );
  if (total + bytes.length > 100 * 1024 * 1024)
    throw new Error("此会话图片已达 100 MiB，请新建对话。");
  try {
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  return {
    file,
    title: "截图",
    mime: upload.mime,
    bytes: bytes.length,
    thumbnail: upload.thumbnail,
  };
}
