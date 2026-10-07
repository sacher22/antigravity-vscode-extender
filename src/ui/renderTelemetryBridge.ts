import type { WebviewMessage, ChatMessage } from "../core/types";
import type { RenderMeasurement, RenderProbeIdentity, RenderProbeKind } from "../core/renderTelemetry";
import { RenderReceiptLedger } from "./renderReceiptLedger";
interface TurnSource {
  sessionId: string; turnId: string; generation: number; messageId: string;
  stepIndex?: number; firstIssued?: boolean; completedIssued?: boolean;
}
/** Annotates only first/completed/recovered source blocks, never every delta. */
export class RenderTelemetryBridge {
  private epoch = 0;
  private turns = new Map<string, TurnSource>();
  private restored = new Set<string>();
  private restoreNeeded = true;
  constructor(
    private readonly record: (measurement: RenderMeasurement) => void,
    private readonly posted: (turnId: string, kind: RenderProbeKind) => void,
    private readonly ledger = new RenderReceiptLedger(),
  ) {}
  newView(): number {this.epoch++;this.clear();return this.epoch;}
  clear(): void {this.ledger.clear();this.turns.clear();this.restored.clear();this.restoreNeeded = true;}
  hidden(): void {this.ledger.clear();this.restored.clear();this.restoreNeeded = true;}
  private remember(source: TurnSource): TurnSource {
    const old = this.turns.get(source.turnId);
    if (old?.sessionId === source.sessionId && old.messageId === source.messageId) {
      old.generation = source.generation;return old;
    }
    while (this.turns.size >= 32) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(source.turnId, source);return source;
  }
  private probe(message: WebviewMessage, source: TurnSource, kind: RenderProbeKind,
    stepIndex: number, minimumSourceLength: number): WebviewMessage {
    const identity: RenderProbeIdentity = {viewEpoch: this.epoch, sessionId: source.sessionId,
      turnId: source.turnId, generation: source.generation, messageId: source.messageId,
      kind, stepIndex, minimumSourceLength};
    try {
      const renderProbe = this.ledger.issue(identity);
      try {this.posted(source.turnId, kind);} catch { /* Optional diagnostics. */ }
      return {...message, renderProbe};
    } catch {return message;}
  }
  private textSource(message: ChatMessage): {stepIndex: number; length: number} | undefined {
    if (message.structuredOutput && message.status !== "running")
      return message.content.trim() ? {stepIndex: -1, length: message.content.length} : undefined;
    const block = message.blocks?.find(block => block.text.trim().length > 0);
    if (block) return {stepIndex: block.stepIndex, length: block.text.length};
    return message.content.trim() ? {stepIndex: -1, length: message.content.length} : undefined;
  }
  decorate(message: WebviewMessage): WebviewMessage {
    if (message.type === "initSession") {
      const active = message.activeTurn;
      const body = active?.message || message.session.messages.slice().reverse().find(
        body => body.role === "assistant" && this.textSource(body));
      let source: TurnSource | undefined;
      if (active?.message.id) source = this.remember({sessionId: message.session.id,
        turnId: active.state.turnId, generation: active.state.generation,
        messageId: active.message.id});
      const text = body && this.textSource(body);
      if (body?.id && text && !this.restored.has(body.id) && (this.restoreNeeded || !source?.firstIssued)) {
        this.restored.add(body.id);
        while (this.restored.size > 32) this.restored.delete(this.restored.values().next().value!);
        source ||= {sessionId: message.session.id, turnId: "restored:" + body.id,
          generation: message.generation ?? 0, messageId: body.id};
        source.firstIssued = true;source.stepIndex = text.stepIndex;
        this.restoreNeeded = false;
        return this.probe(message, source, "restoredText", text.stepIndex, text.length);
      }
      this.restoreNeeded = false;
    } else if (message.type === "streamDelta" && message.turnId) {
      const source = this.turns.get(message.turnId);
      if (source && !source.firstIssued && source.sessionId === message.sessionId && /\S/.test(message.delta)) {
        source.generation = message.generation ?? source.generation;
        source.stepIndex = message.stepIndex;source.firstIssued = true;
        return this.probe(message, source, "firstText", message.stepIndex, message.delta.length);
      }
    } else if (message.type === "turnComplete" && message.turnId) {
      const source = this.turns.get(message.turnId);
      if (source && !source.completedIssued && source.sessionId === message.sessionId &&
          source.messageId === message.messageId && source.stepIndex !== undefined) {
        source.completedIssued = true;
        const blocks = message.changes?.blocks;
        const stepIndex = message.changes?.structuredOutput || blocks?.length === 0
          ? -1 : blocks?.[0]?.stepIndex ?? source.stepIndex;
        return this.probe(message, source, "completedText", stepIndex, 1);
      }
    }
    return message;
  }
  accept(receipt: unknown, receiverEpoch: number, session: string | undefined, visible: boolean): void {
    if (receiverEpoch !== this.epoch) return;
    try {
      const measured = this.ledger.accept(receipt, this.epoch, session, visible);
      if (measured) this.record(measured);
    } catch { /* Malformed telemetry never interrupts interface commands. */ }
  }
  stats() {return {...this.ledger.stats(), sourceEntries: this.turns.size, restoredEntries: this.restored.size};}
}
