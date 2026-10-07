import type { RenderProbe, RenderReceipt } from "../core/renderTelemetry";

function visibleText(element: HTMLElement): boolean {
  if (!element.isConnected || document.visibilityState === "hidden") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const pane = element.closest(".messages")?.getBoundingClientRect();
  const top = Math.max(0, pane?.top ?? 0);
  const bottom = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight);
  const left = Math.max(0, pane?.left ?? 0);
  const right = Math.min(window.innerWidth, pane?.right ?? window.innerWidth);
  if (bottom <= top || right <= left) return false;
  const intersects = (r: DOMRect) => r.width > 0 && r.height > 0 &&
    r.bottom > top && r.top < bottom && r.right > left && r.left < right;
  if (!intersects(rect)) return false;
  // Match an actual source text glyph. Container boxes can remain visible while
  // all text is inside a closed details element or clipped out of the pane.
  const glyphVisible = (node: Node, offset: number) => {
    if (node.nodeType !== 3 || !element.contains(node)) return false;
    const text = node as Text;
    // Chromium can expose layout ranges for contents of closed details even
    // though those glyphs are not presented. Check the source's ancestors.
    let ancestor = text.parentElement;
    for (let depth = 0; ancestor && depth < 128; depth++, ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility !== "visible" || style.display === "none" || style.opacity === "0") return false;
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
        const summary = Array.from(ancestor.children).find(child => child.tagName === "SUMMARY");
        if (!summary?.contains(text)) return false;
      }
      if (ancestor === element) break;
      if (depth === 127) return false;
    }
    const at = Math.min(Math.max(0, offset), text.length - 1);
    if (at < 0 || !text.data.slice(at, at + 2).trim()) return false;
    const range = document.createRange();
    range.setStart(text, at);range.setEnd(text, Math.min(text.length, at + 2));
    return typeof range.getBoundingClientRect === "function" && intersects(range.getBoundingClientRect());
  };
  const caret = document.caretRangeFromPoint?.bind(document);
  if (caret) {
    const x0 = Math.max(left, rect.left), x1 = Math.min(right, rect.right);
    const y0 = Math.max(top, rect.top), y1 = Math.min(bottom, rect.bottom);
    for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
      const point = caret(x0 + (x1 - x0) * x, y0 + (y1 - y0) * y);
      if (point && glyphVisible(point.startContainer, point.startOffset)) return true;
    }
  }
  // Bounded fallback; missing glyph evidence produces no sample.
  const walker = document.createTreeWalker(element, 4);
  for (let i = 0; i < 24 && walker.nextNode(); i++) {
    const node = walker.currentNode as Text;
    if (glyphVisible(node, 0) || glyphVisible(node, node.length - 2)) return true;
  }
  return false;
}
interface PendingRender {
  probe: RenderProbe;
  receivedAt: number;
  element?: HTMLElement;
  domAt?: number;
  sourceLength?: number;
  completed?: boolean;
  frames: number[];
}
/** At most two paint opportunities per sample; never an interval or per-token acknowledgement. */
export class RenderObserver {
  private pending = new Map<string, PendingRender>();
  private session?: string;
  constructor(
    private readonly send: (receipt: RenderReceipt) => void,
    private readonly currentSession: () => string | undefined,
    private readonly now = () => performance.now(),
    private readonly frame = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    private readonly cancelFrame = (id: number) => cancelAnimationFrame(id),
    private readonly visible = visibleText,
  ) {}
  private remove(token: string): void {
    const item = this.pending.get(token);
    if (!item) return;
    for (const id of item.frames) this.cancelFrame(id);
    this.pending.delete(token);
  }
  clear(): void {
    for (const token of Array.from(this.pending.keys())) this.remove(token);
  }
  selectSession(session: string | undefined): void {
    if (session === this.session) return;
    this.session = session;
    this.clear();
  }
  private prune(): void {
    if (!this.pending.size) return;
    const now = this.now();
    for (const [token, item] of this.pending) {
      if (!Number.isFinite(now) || now < item.receivedAt || now - item.receivedAt >= 30000)
        this.remove(token);
    }
  }
  receive(probe: RenderProbe): void {
    this.prune();
    if (!probe || probe.sessionId !== this.currentSession() || this.pending.has(probe.token)) return;
    const receivedAt = this.now();
    if (!Number.isFinite(receivedAt) || receivedAt < 0) return;
    while (this.pending.size >= 32) this.remove(this.pending.keys().next().value!);
    this.pending.set(probe.token, {probe: {
      token: probe.token, viewEpoch: probe.viewEpoch, sessionId: probe.sessionId,
      turnId: probe.turnId, generation: probe.generation, messageId: probe.messageId,
      stepIndex: probe.stepIndex, kind: probe.kind, minimumSourceLength: probe.minimumSourceLength,
    }, receivedAt, frames: []});
  }
  domUpdated(messageId: string | undefined, stepIndex: number | undefined,
    sourceLength: number, completed: boolean, element: HTMLElement): void {
    if (!this.pending.size) return;
    this.prune();
    for (const item of this.pending.values()) {
      const probe = item.probe;
      if (probe.messageId !== messageId || probe.stepIndex !== (stepIndex ?? -1) ||
          sourceLength < probe.minimumSourceLength || !element.textContent ||
          (probe.kind === "completedText" && !completed)) continue;
      // Mark the actual source block after its DOM update, not an unrelated mutation.
      item.element = element;
      item.domAt ??= this.now();
      item.sourceLength = sourceLength;
      item.completed = completed;
      this.schedule(item);
    }
  }
  retryVisible(): void {
    if (!this.pending.size) return;
    this.prune();
    for (const item of this.pending.values()) this.schedule(item);
  }
  private schedule(item: PendingRender): void {
    if (item.frames.length || !item.element || item.domAt === undefined ||
        item.probe.sessionId !== this.currentSession() || !this.visible(item.element)) return;
    const first = this.frame(() => {
      if (this.pending.get(item.probe.token) !== item) return;
      item.frames = [this.frame(() => {
        if (this.pending.get(item.probe.token) !== item) return;
        item.frames = [];
        this.prune();
        if (this.pending.get(item.probe.token) !== item ||
            item.probe.sessionId !== this.currentSession() ||
            !item.element || !this.visible(item.element)) return;
        const finished = this.now(), dom = item.domAt!;
        if (!Number.isFinite(dom) || !Number.isFinite(finished) || dom < item.receivedAt || finished < dom) {
          this.remove(item.probe.token); return;
        }
        const receipt: RenderReceipt = {...item.probe,
          receiptToDOMMs: dom - item.receivedAt, DOMToFrameMs: finished - dom,
          sourceLength: item.sourceLength!, completed: !!item.completed, visible: true};
        this.remove(item.probe.token);
        // Telemetry must never make input/rendering fail if transport is gone.
        try {this.send(receipt);} catch { /* Disposed Webview. */ }
      })];
    });
    item.frames = [first];
  }
  stats(): {pending: number} {this.prune();return {pending: this.pending.size};}
}
