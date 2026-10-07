import { randomUUID } from "node:crypto";
import type {
  RenderMeasurement,
  RenderProbe,
  RenderProbeIdentity,
  RenderProbeKind,
} from "../core/renderTelemetry";

interface PendingEntry extends RenderProbeIdentity {
  token: string;
  sentAt: number;
}

export class RenderReceiptLedger {
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly maxPending: number;
  private readonly ttlMs: number;
  private readonly pending = new Map<string, PendingEntry>();
  private acceptedCount = 0;
  private rejectedCount = 0;
  private expiredCount = 0;
  private evictedCount = 0;

  constructor(
    now: () => number = () => performance.now(),
    nonce: () => string = randomUUID,
    maxPending = 32,
    ttlMs = 30000,
  ) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof nonce !== "function") throw new TypeError("nonce must be a function");
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) {
      throw new RangeError("maxPending must be an integer between 1 and 1024");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60000) {
      throw new RangeError("ttlMs must be a positive finite number <= 60000");
    }
    this.now = now;
    this.nonce = nonce;
    this.maxPending = maxPending;
    this.ttlMs = ttlMs;
  }

  private sweep(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs < 0) return;
    for (const [token, entry] of this.pending) {
      if (nowMs - entry.sentAt >= this.ttlMs) {
        this.pending.delete(token);
        this.expiredCount++;
      }
    }
  }

  public issue(identity: RenderProbeIdentity): RenderProbe {
    const sentAt = this.now();
    if (!Number.isFinite(sentAt) || sentAt < 0) {
      throw new Error("Invalid clock timestamp");
    }
    this.sweep(sentAt);

    if (
      typeof identity !== "object" ||
      identity === null ||
      Array.isArray(identity) ||
      !Number.isSafeInteger(identity.viewEpoch) ||
      identity.viewEpoch < 0 ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 0 ||
      !Number.isSafeInteger(identity.stepIndex) ||
      identity.stepIndex < -1 ||
      !Number.isSafeInteger(identity.minimumSourceLength) ||
      identity.minimumSourceLength < 1 ||
      identity.minimumSourceLength > 50000000 ||
      typeof identity.sessionId !== "string" ||
      identity.sessionId.length < 1 ||
      identity.sessionId.length > 128 ||
      typeof identity.turnId !== "string" ||
      identity.turnId.length < 1 ||
      identity.turnId.length > 128 ||
      typeof identity.messageId !== "string" ||
      identity.messageId.length < 1 ||
      identity.messageId.length > 128 ||
      (identity.kind !== "firstText" &&
        identity.kind !== "completedText" &&
        identity.kind !== "restoredText")
    ) {
      throw new TypeError("Invalid RenderProbeIdentity");
    }

    const token = this.nonce();
    if (typeof token !== "string" || token.length < 1 || token.length > 128) {
      throw new Error("Invalid nonce");
    }
    if (this.pending.has(token)) {
      throw new Error("Duplicate nonce");
    }

    if (this.pending.size >= this.maxPending) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey !== undefined) {
        this.pending.delete(oldestKey);
        this.evictedCount++;
      }
    }

    const record: PendingEntry = {
      viewEpoch: identity.viewEpoch,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      generation: identity.generation,
      messageId: identity.messageId,
      stepIndex: identity.stepIndex,
      kind: identity.kind,
      minimumSourceLength: identity.minimumSourceLength,
      token,
      sentAt,
    };
    this.pending.set(token, record);

    return {
      viewEpoch: record.viewEpoch,
      sessionId: record.sessionId,
      turnId: record.turnId,
      generation: record.generation,
      messageId: record.messageId,
      stepIndex: record.stepIndex,
      kind: record.kind,
      minimumSourceLength: record.minimumSourceLength,
      token: record.token,
    };
  }

  public accept(
    raw: unknown,
    viewEpoch: number,
    currentSession: string | undefined,
    hostVisible: boolean,
  ): RenderMeasurement | undefined {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      this.rejectedCount++;
      return undefined;
    }
    this.sweep(nowMs);

    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !hostVisible) {
      this.rejectedCount++;
      return undefined;
    }

    const r = raw as Record<string, unknown>;
    if (typeof r.token !== "string") {
      this.rejectedCount++;
      return undefined;
    }

    const entry = this.pending.get(r.token);
    if (!entry) {
      this.rejectedCount++;
      return undefined;
    }

    if (
      r.token !== entry.token ||
      r.viewEpoch !== entry.viewEpoch ||
      r.sessionId !== entry.sessionId ||
      r.turnId !== entry.turnId ||
      r.generation !== entry.generation ||
      r.messageId !== entry.messageId ||
      r.stepIndex !== entry.stepIndex ||
      r.kind !== entry.kind ||
      r.minimumSourceLength !== entry.minimumSourceLength ||
      viewEpoch !== entry.viewEpoch ||
      currentSession !== entry.sessionId ||
      r.visible !== true ||
      typeof r.completed !== "boolean" ||
      (entry.kind === "completedText" && r.completed !== true) ||
      !Number.isSafeInteger(r.sourceLength) ||
      (r.sourceLength as number) < entry.minimumSourceLength ||
      (r.sourceLength as number) > 50000000 ||
      typeof r.receiptToDOMMs !== "number" ||
      !Number.isFinite(r.receiptToDOMMs) ||
      r.receiptToDOMMs < 0 ||
      r.receiptToDOMMs > this.ttlMs ||
      typeof r.DOMToFrameMs !== "number" ||
      !Number.isFinite(r.DOMToFrameMs) ||
      r.DOMToFrameMs < 0 ||
      r.DOMToFrameMs > this.ttlMs
    ) {
      this.rejectedCount++;
      return undefined;
    }

    const actualRoundtrip = nowMs - entry.sentAt;
    if (actualRoundtrip < 0 || r.receiptToDOMMs + r.DOMToFrameMs > actualRoundtrip + 2) {
      this.rejectedCount++;
      return undefined;
    }

    this.pending.delete(entry.token);
    this.acceptedCount++;

    return {
      turnId: entry.turnId,
      kind: entry.kind,
      hostPostToAckUpperBoundMs: actualRoundtrip,
      receiptToDOMMs: r.receiptToDOMMs,
      DOMToFrameMs: r.DOMToFrameMs,
      sourceLength: r.sourceLength as number,
    };
  }

  public clear(): void {
    this.pending.clear();
    this.acceptedCount = 0;
    this.rejectedCount = 0;
    this.expiredCount = 0;
    this.evictedCount = 0;
  }

  public stats(): {
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
    evicted: number;
  } {
    const nowMs = this.now();
    if (Number.isFinite(nowMs) && nowMs >= 0) {
      this.sweep(nowMs);
    }
    return {
      pending: this.pending.size,
      accepted: this.acceptedCount,
      rejected: this.rejectedCount,
      expired: this.expiredCount,
      evicted: this.evictedCount,
    };
  }
}
