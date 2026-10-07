import { randomUUID } from "node:crypto";
import type {
  RequestMeasurement,
  RequestProbe,
  RequestProbeIdentity,
  RequestReceipt,
  TrackedRequestCommand,
} from "../core/requestTelemetry";

interface PendingEntry {
  token: string;
  requestId: string;
  viewEpoch: number;
  command: TrackedRequestCommand;
  sessionId?: string;
  turnId?: string;
  uiQueuedMs: number;
  issuedAt: number;
}

export class RequestReceiptLedger {
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
    maxPending = 64,
    ttlMs = 30000,
  ) {
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (typeof nonce !== "function") {
      throw new TypeError("nonce must be a function");
    }
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) {
      throw new RangeError("maxPending must be an integer between 1 and 1024");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 120000) {
      throw new RangeError("ttlMs must be a positive finite number <= 120000");
    }
    this.now = now;
    this.nonce = nonce;
    this.maxPending = maxPending;
    this.ttlMs = ttlMs;
  }

  private sweep(nowMs: number): void {
    if (!Number.isFinite(nowMs) || nowMs < 0) return;
    for (const [token, entry] of this.pending) {
      if (nowMs - entry.issuedAt >= this.ttlMs) {
        this.pending.delete(token);
        this.expiredCount++;
      }
    }
  }

  public issue(identity: RequestProbeIdentity): RequestProbe {
    const issuedAt = this.now();
    if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || issuedAt < 0) {
      throw new Error("Invalid clock timestamp");
    }
    this.sweep(issuedAt);

    if (
      typeof identity !== "object" ||
      identity === null ||
      Array.isArray(identity) ||
      typeof identity.requestId !== "string" ||
      identity.requestId.length < 1 ||
      identity.requestId.length > 128 ||
      !Number.isSafeInteger(identity.viewEpoch) ||
      identity.viewEpoch < 0 ||
      (identity.command !== "sendMessage" && identity.command !== "abortCurrentTurn") ||
      (identity.sessionId !== undefined &&
        (typeof identity.sessionId !== "string" ||
          identity.sessionId.length < 1 ||
          identity.sessionId.length > 128)) ||
      (identity.turnId !== undefined &&
        (typeof identity.turnId !== "string" ||
          identity.turnId.length < 1 ||
          identity.turnId.length > 128)) ||
      typeof identity.uiQueuedMs !== "number" ||
      !Number.isFinite(identity.uiQueuedMs) ||
      identity.uiQueuedMs < 0 ||
      identity.uiQueuedMs > 120000
    ) {
      throw new TypeError("Invalid RequestProbeIdentity");
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
      token,
      requestId: identity.requestId,
      viewEpoch: identity.viewEpoch,
      command: identity.command,
      uiQueuedMs: identity.uiQueuedMs,
      issuedAt,
    };
    if (typeof identity.sessionId === "string") {
      record.sessionId = identity.sessionId;
    }
    if (typeof identity.turnId === "string") {
      record.turnId = identity.turnId;
    }
    this.pending.set(token, record);

    return {
      token: record.token,
      requestId: record.requestId,
      viewEpoch: record.viewEpoch,
    };
  }

  public accept(value: unknown, receiverEpoch: number): RequestMeasurement | undefined {
    try {
      const nowMs = this.now();
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
        this.rejectedCount++;
        return undefined;
      }
      this.sweep(nowMs);

      if (!Number.isSafeInteger(receiverEpoch) || receiverEpoch < 0) {
        this.rejectedCount++;
        return undefined;
      }

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        this.rejectedCount++;
        return undefined;
      }

      const r = value as Record<string, unknown>;
      if (
        typeof r.token !== "string" ||
        typeof r.requestId !== "string" ||
        typeof r.viewEpoch !== "number"
      ) {
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
        r.requestId !== entry.requestId ||
        r.viewEpoch !== entry.viewEpoch ||
        receiverEpoch !== entry.viewEpoch
      ) {
        this.rejectedCount++;
        return undefined;
      }

      if (
        typeof r.postToObservedUpperBoundMs !== "number" ||
        !Number.isFinite(r.postToObservedUpperBoundMs) ||
        r.postToObservedUpperBoundMs < 0 ||
        r.postToObservedUpperBoundMs > 120000
      ) {
        this.rejectedCount++;
        return undefined;
      }

      const hostReceiptToReportMs = nowMs - entry.issuedAt;
      if (
        !Number.isFinite(hostReceiptToReportMs) ||
        hostReceiptToReportMs < 0 ||
        hostReceiptToReportMs > 120000
      ) {
        this.rejectedCount++;
        return undefined;
      }

      this.pending.delete(entry.token);
      this.acceptedCount++;

      const measurement: RequestMeasurement = {
        requestId: entry.requestId,
        command: entry.command,
        uiQueuedMs: entry.uiQueuedMs,
        postToObservedUpperBoundMs: r.postToObservedUpperBoundMs,
        hostReceiptToReportMs,
      };
      if (entry.sessionId !== undefined) {
        measurement.sessionId = entry.sessionId;
      }
      if (entry.turnId !== undefined) {
        measurement.turnId = entry.turnId;
      }

      return measurement;
    } catch {
      this.rejectedCount++;
      return undefined;
    }
  }

  public clear(): void {
    this.pending.clear();
  }

  public stats(): {
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
    evicted: number;
    maxPending: number;
    ttlMs: number;
  } {
    const nowMs = this.now();
    if (typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs >= 0) {
      this.sweep(nowMs);
    }
    return {
      pending: this.pending.size,
      accepted: this.acceptedCount,
      rejected: this.rejectedCount,
      expired: this.expiredCount,
      evicted: this.evictedCount,
      maxPending: this.maxPending,
      ttlMs: this.ttlMs,
    };
  }
}
