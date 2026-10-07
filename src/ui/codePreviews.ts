import { randomUUID, createHash } from "crypto";

export interface CodePreview {
  sessionId: string;
  messageId: string;
  blockIndex: number;
  target: string;
  version: number;
  originalHash: string;
  code: string;
  diffUri: string;
}
export const contentHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Tokens identify the exact reviewed change, never the active editor at apply time. */
export class CodePreviews {
  private entries = new Map<string, CodePreview>();
  constructor(
    private readonly released: (preview: CodePreview) => void,
    private readonly limit = 32,
  ) {}
  create(preview: CodePreview) {
    const id = randomUUID();
    this.entries.set(id, { ...preview });
    while (this.entries.size > this.limit)
      this.remove(this.entries.keys().next().value!);
    return id;
  }
  get(
    id: string,
    sessionId: string,
    messageId: string,
    blockIndex: number,
    code: string,
  ) {
    const preview = this.entries.get(id);
    if (
      !preview ||
      preview.sessionId !== sessionId ||
      preview.messageId !== messageId ||
      preview.blockIndex !== blockIndex ||
      preview.code !== code
    )
      throw new Error("预览已过期或不属于当前代码块，请重新预览。 ");
    return preview;
  }
  remove(id: string) {
    const preview = this.entries.get(id);
    if (preview) {
      this.entries.delete(id);
      this.released(preview);
    }
  }
  closeDocument(uri: string) {
    for (const [id, preview] of this.entries)
      if (preview.diffUri === uri) this.remove(id);
  }
  dispose() {
    for (const id of this.entries.keys()) this.remove(id);
  }
}
