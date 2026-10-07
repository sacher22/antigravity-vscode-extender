import { OperationCancelledError } from "../core/operationErrors";
import type { ExtensionMessage, WebviewMessage } from "../core/types";

/** Timeouts release UI controls without resubmitting an operation of unknown outcome. */
export class RequestClient {
  private readonly instance =
    crypto.randomUUID?.() ||
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
      n.toString(16),
    ).join("-");
  private counter = 0;
  private pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      sentAt?: number;
      observed?: boolean;
    }
  >();
  constructor(
    private readonly send: (data: unknown) => void,
    private readonly session: () => string | undefined,
    private readonly timeoutMs = 120000,
    private readonly now: () => number = () => performance.now(),
  ) {}
  request(data: Partial<ExtensionMessage>): Promise<void> {
    const requestId = `${this.instance}:${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `操作 ${data.command} 的结果未确认。请同步会话后检查结果，勿重复提交执行操作。`,
          ),
        );
      }, this.timeoutMs);
      const tracked = data.command === "sendMessage" || data.command === "abortCurrentTurn";
      this.pending.set(requestId, { resolve, reject, timer, ...(tracked ? {sentAt: this.now()} : {}) });
      try {
        this.send({
          ...data,
          requestId,
          ...(tracked ? {requestTiming: {uiQueuedMs: data.requestTiming?.uiQueuedMs ?? 0}} : {}),
          sessionId: data.sessionId || this.session(),
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  receive(message: WebviewMessage) {
    if (message.type === "requestObserved") {
      const probe = message.probe;
      const pending = probe && this.pending.get(probe.requestId);
      if (pending?.sentAt !== undefined && !pending.observed &&
          typeof probe.token === "string" && probe.token.length >= 1 && probe.token.length <= 128 &&
          Number.isSafeInteger(probe.viewEpoch) && probe.viewEpoch >= 0) {
        const elapsed = this.now() - pending.sentAt;
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 120000) {
          pending.observed = true;
          try {this.send({command: "reportRequestLatency", receipt: {
            token: probe.token, requestId: probe.requestId, viewEpoch: probe.viewEpoch,
            postToObservedUpperBoundMs: elapsed,
          }});} catch { /* Optional telemetry never rejects the user operation. */ }
        }
      }
      return;
    }

    if (
      (message.type !== "requestComplete" &&
        message.type !== "requestFailed") ||
      !message.requestId
    )
      return;
    const request = this.pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.requestId);
    if (message.type === "requestFailed")
      request.reject(message.cancelled ? new OperationCancelledError(message.message) : new Error(message.message));
    else request.resolve();
  }
  dispose() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("界面已关闭，操作结果请在恢复会话后查看。"));
    }
    this.pending.clear();
  }
}
