import type {RequestMeasurement} from "../core/requestTelemetry";
import type { RenderMeasurement } from "../core/renderTelemetry";
import { createHmac, randomBytes } from "crypto";

const milestones = new Set(["accepted", "storage-committed", "capability-check-start", "capability-check-end", "cli-ready", "stdin-submitted", "first-cli-text", "execution-ended", "connecting", "submitted", "responding", "tool", "waiting", "stopping", "completed", "aborted", "failed", "permission_denied", "webview-first-posted", "webview-completed-posted", "webview-restored-posted"]);
export class DiagnosticJournal {
  private readonly salt = randomBytes(32);
  private events: Array<
    {turn: string; request?: string; milestone: string; elapsedMs: number} |
    (Omit<RequestMeasurement, "requestId" | "sessionId" | "turnId"> & {request: string; session?: string; turn?: string; milestone: "request-boundary"}) |
    (Omit<RenderMeasurement, "turnId"> & {turn: string; milestone: "webview-render"})
  > = [];
  private bytes = 0;
  private discarded = 0;
  pseudonym(id: string): string {return createHmac("sha256", this.salt).update(id).digest("hex").slice(0, 20);}
  record(turnId: string, milestone: string, elapsedMs: number, requestId?: string): void {
    if (!milestones.has(milestone) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const event = {turn: this.pseudonym(turnId), ...(requestId ? {request: this.pseudonym(requestId)} : {}), milestone, elapsedMs: Math.round(elapsedMs * 1000) / 1000};
    this.append(event);
  }
  private append(event: typeof this.events[number]): void {
    this.events.push(event);
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    while (this.events.length > 512 || this.bytes > 256 * 1024) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
      this.discarded++;
    }
  }
  recordRender(measurement: RenderMeasurement): void {
    if (!measurement || typeof measurement.turnId !== "string" || measurement.turnId.length < 1 || measurement.turnId.length > 128 ||
        !["firstText", "completedText", "restoredText"].includes(measurement.kind) ||
        !Number.isSafeInteger(measurement.sourceLength) || measurement.sourceLength < 1 || measurement.sourceLength > 50000000 ||
        [measurement.hostPostToAckUpperBoundMs, measurement.receiptToDOMMs, measurement.DOMToFrameMs]
          .some(value => !Number.isFinite(value) || value < 0 || value > 60000) ||
        measurement.receiptToDOMMs + measurement.DOMToFrameMs > measurement.hostPostToAckUpperBoundMs + 2) return;
    this.append({turn: this.pseudonym(measurement.turnId), milestone: "webview-render", kind: measurement.kind,
      hostPostToAckUpperBoundMs: measurement.hostPostToAckUpperBoundMs,
      receiptToDOMMs: measurement.receiptToDOMMs, DOMToFrameMs: measurement.DOMToFrameMs,
      sourceLength: measurement.sourceLength});
  }
  recordRequest(measurement: RequestMeasurement): void {
    if (!measurement || typeof measurement.requestId !== "string" || measurement.requestId.length < 1 || measurement.requestId.length > 128 ||
        !["sendMessage", "abortCurrentTurn"].includes(measurement.command) ||
        [measurement.uiQueuedMs, measurement.postToObservedUpperBoundMs, measurement.hostReceiptToReportMs]
          .some(value => !Number.isFinite(value) || value < 0 || value > 120000)) return;
    this.append({milestone: "request-boundary", request: this.pseudonym(measurement.requestId),
      ...(measurement.sessionId ? {session: this.pseudonym(measurement.sessionId)} : {}),
      ...(measurement.turnId ? {turn: this.pseudonym(measurement.turnId)} : {}),
      command: measurement.command, uiQueuedMs: measurement.uiQueuedMs,
      postToObservedUpperBoundMs: measurement.postToObservedUpperBoundMs,
      hostReceiptToReportMs: measurement.hostReceiptToReportMs});
  }
  clear(): void {this.events = []; this.bytes = 0; this.discarded = 0;}
  snapshot() {
    return {schemaVersion: 3, events: this.events.map(event => ({...event})), discarded: this.discarded,
      estimatedEventBytes: this.bytes, maxEvents: 512, maxEventBytes: 256 * 1024,
      scope: "host-and-render-segments", notes: ["Request boundary durations use each process own monotonic clock. Browser post-to-observed is a round-trip upper bound on inbound delivery, not exact click-to-host latency. UI queued includes draft save before posting; Host receipt-to-report includes both telemetry IPC directions. Only send/stop are sampled once; no prompts or raw request/session IDs retained. Host accepted turn milestones correlate by pseudonymous request ID.","No prompts, tool bodies, paths or credentials are recorded.", "Storage-committed follows successful message writes and session metadata atomic replacement (or resolved legacy state update); it does not promise fsync or crash durability. Commit correlation is bounded to 32 messages per runner and expires after five minutes.", "First CLI text is an observed protocol event, not the model's first token.", "Render samples match a source block with DOM text in the viewport and two animation-frame opportunities; actual pixels and model internal timing are not measured.", "Host post-to-ack is an upper bound including return IPC/Host dispatch. Browser receipt-to-DOM and DOM-to-frame are local durations; clocks are not subtracted across processes.", "Hidden/offscreen/expired targets have no visibility sample. Completed-text means a rendered terminal phase, including preserved stopped/error output."]};
  }
}
