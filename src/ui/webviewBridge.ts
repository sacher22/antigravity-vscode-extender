import { OperationCancelledError } from "../core/operationErrors";
import { combineContext } from "../core/contextAttachments";
import { ExtensionMessage, WebviewMessage } from "../core/types";
const strings: Record<string, string[]> = {
  approvePlan: ["messageId"],
  viewDiff: ["messageId", "code"],
  applyCodeToEditor: ["messageId", "code", "previewId"],
  getAgentDetail: ["agentId"],
  sendMessage: ["text"],
  saveDraft: ["text"],
  switchSession: ["conversationId"],
  deleteSession: ["conversationId"],
  changeModel: ["model", "effort"],
  openResource: ["href"],
  copyToClipboard: ["text"],
};
const commands = new Set([
  "approvePlan",
  "getAgents",
  "getAgentDetail",
  "watchAgents",
  "ready",
  "sendMessage",
  "saveDraft",
  "pasteImage",
  "newSession",
  "pickSession",
  "switchSession",
  "deleteSession",
  "changeModel",
  "togglePermission",
  "togglePlanMode",
  "abortCurrentTurn",
  "openNativeCli",
  "loadHistory",
  "getToolDetail",
  "openResource",
  "requestContext",
  "openSettings",
  "openWorkspace",
  "viewDiff",
  "applyCodeToEditor",
  "copyToClipboard",
  "reportRender",
]);
export function validateRequest(value: unknown): ExtensionMessage {
  if (!value || typeof value !== "object") throw new Error("无效的界面请求。");
  const d = value as Record<string, unknown>;
  if (typeof d.command !== "string" || !commands.has(d.command))
    throw new Error("不支持的界面操作。");
  if (typeof d.requestId !== "string" || d.requestId.length > 128)
    throw new Error("界面请求缺少有效标识。");
  for (const key of strings[d.command] || [])
    if (typeof d[key] !== "string") throw new Error("界面请求参数不正确。");
  if (
    d.command === "requestContext" &&
    !["file", "problems", "selection"].includes(String(d.contextType))
  )
    throw new Error("无效的上下文类型。");
  if (d.command === "pasteImage" && (!d.image || typeof d.image !== "object"))
    throw new Error("无效的图片附件。");
  if (d.contextCode !== undefined && typeof d.contextCode !== "string")
    throw new Error("无效的上下文。");
  if (
    d.command === "saveDraft" &&
    d.attachment !== undefined &&
    (!d.attachment ||
      typeof d.attachment !== "object" ||
      typeof (d.attachment as { code: unknown }).code !== "string")
  )
    throw new Error("无效的附件。");
  if (d.command === "saveDraft" && d.attachment) {
    const attachment = d.attachment as { items?: unknown; code: string };
    if (attachment.items !== undefined && !Array.isArray(attachment.items))
      throw new Error("无效的附件列表。");
    combineContext(
      attachment.items === undefined ? [attachment] : attachment.items,
    );
  }
  if (d.sessionId !== undefined && typeof d.sessionId !== "string")
    throw new Error("无效的会话标识。");
  if (
    d.command === "changeModel" &&
    (!["low", "medium", "high", "max"].includes(String(d.effort)) ||
      !/^[-a-zA-Z0-9_.]+$/.test(String(d.model)))
  )
    throw new Error("无效的模型配置。");
  for (const [command, key] of [
    ["watchAgents", "enabled"],
    ["togglePermission", "dangerouslySkipPermissions"],
    ["togglePlanMode", "isPlanMode"],
  ])
    if (d.command === command && typeof d[key] !== "boolean")
      throw new Error("无效的模式配置。");
  for (const [command, key] of [
    ["viewDiff", "blockIndex"],
    ["applyCodeToEditor", "blockIndex"],
    ["loadHistory", "before"],
    ["getToolDetail", "stepIndex"],
  ])
    if (
      d.command === command &&
      (typeof d[key] !== "number" || !Number.isFinite(d[key]))
    )
      throw new Error("无效的分页参数。");
  if (
    ["viewDiff", "applyCodeToEditor"].includes(d.command) &&
    (!Number.isInteger(d.blockIndex) || (d.blockIndex as number) < 0)
  )
    throw new Error("无效的代码块标识。");
  if (
    d.offset !== undefined &&
    (!Number.isInteger(d.offset) || (d.offset as number) < 0)
  )
    throw new Error("无效的工具输出页码。");
  if (
    ["viewDiff", "applyCodeToEditor"].includes(d.command) &&
    typeof d.code !== "string"
  )
    throw new Error("无效的代码。");
  return value as ExtensionMessage;
}
/** Request deduplication survives Webview rebuilds. Results preserve originating session identity. */
export class WebviewBridge {
  private requests = new Map<string, Promise<WebviewMessage>>();
  private completed = new Set<string>();
  constructor(
    private readonly handle: (data: ExtensionMessage) => Promise<void>,
    private readonly send: (data: WebviewMessage) => void,
    private readonly current: () => string | undefined,
    private readonly observed?: (data: ExtensionMessage) => void,
  ) {}
  async receive(raw: unknown): Promise<void> {
    let d: ExtensionMessage;
    try {
      d = validateRequest(raw);
    } catch (e) {
      const v = raw as Partial<ExtensionMessage>;
      this.send({
        type: "requestFailed",
        requestId: v?.requestId,
        message: String(e),
        command: v?.command,
      });
      return;
    }
    const existing = this.requests.get(d.requestId!);
    if (existing) {
      this.send(await existing);
      return;
    }
    const work = async (): Promise<WebviewMessage> => {
      try {
        if (
          d.command !== "ready" &&
          d.command !== "reportRender" &&
          d.sessionId &&
          d.sessionId !== this.current()
        )
          throw new Error("会话已切换，请重试当前操作。");
        await this.handle(d);
        return {
          type: "requestComplete",
          requestId: d.requestId,
          command: d.command,
          sessionId: d.sessionId,
          targetSessionId: this.current(),
        };
      } catch (e) {
        return {
          type: "requestFailed",
          requestId: d.requestId,
          sessionId: d.sessionId,
          command: d.command,
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof OperationCancelledError ? { cancelled: true } : {}),
        };
      }
    };
    const p = Promise.resolve().then(work);
    this.requests.set(d.requestId!, p);
    try {
      this.observed?.(d);
    } catch {
      /* Optional telemetry cannot block an operation. */
    }
    const result = await p;
    this.completed.add(d.requestId!);
    while (this.completed.size > 1024) {
      const oldest = this.completed.values().next().value!;
      this.completed.delete(oldest);
      this.requests.delete(oldest);
    }
    this.send(result);
  }
}
