import {
  IMAGE_MAX_BYTES,
  IMAGE_THUMBNAIL_CHARS,
} from "../core/imageAttachments";
import type { ImageUpload } from "../core/types";
export async function imageUpload(file: File): Promise<ImageUpload> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > IMAGE_MAX_BYTES
  )
    throw new Error("仅支持不超过 5 MiB 的 PNG、JPEG、WebP 截图。");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("截图预览不可用");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL("image/jpeg", 0.65);
    if (thumbnail.length > IMAGE_THUMBNAIL_CHARS)
      throw new Error("截图缩略图过大");
    return { mime: file.type, data, thumbnail };
  } finally {
    bitmap.close();
  }
}
