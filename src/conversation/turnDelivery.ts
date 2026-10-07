import type { ToolCallItem, TurnState, WebviewMessage } from "../core/types";
import { textFragments, toolBatches, type PendingTool } from "./deliveryFragments";

/** One turn's unsent previews only. Transcript, CLI and execution ownership stay outside. */
export class TurnDelivery {
  private text = new Map<number, {text: string; receivedAt: number}>();
  private tools = new Map<number, PendingTool>();
  private state?: TurnState;
  private timer?: unknown;
  private timerToken?: object;
  private closed = false;
  private flushing = false;
  constructor(
    private readonly emit: (message: WebviewMessage) => void,
    private readonly generation: () => number,
    private readonly isCurrent: () => boolean,
    private readonly setTimer: (callback: () => void) => unknown = callback => setTimeout(callback, 30),
    private readonly clearTimer: (handle: unknown) => void = handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ) {}
  private live(): boolean {
    if (this.closed) return false;
    if (!this.isCurrent()) {this.dispose();return false;}
    return true;
  }
  private schedule(): void {
    if (this.timerToken) return;
    const token = this.timerToken = {};
    const handle = this.setTimer(() => {
      if (this.timerToken === token) this.flush();
    });
    if (this.timerToken === token) this.timer = handle;
    else this.clearTimer(handle);
  }
  private cancel(): void {
    if (!this.timerToken) return;
    const handle = this.timer;
    this.timerToken = undefined;this.timer = undefined;
    this.clearTimer(handle);
  }
  appendText(stepIndex: number, delta: string, receivedAt: number): void {
    if (!delta || !this.live()) return;
    const old = this.text.get(stepIndex);
    this.text.set(stepIndex, {text: (old?.text || "") + delta, receivedAt: old?.receivedAt ?? receivedAt});
    this.schedule();
  }
  /** estimatedBytes is internal: reuse the Controller's compacted JSON size. */
  replaceTool(tool: ToolCallItem, estimatedBytes?: number): void {
    if (!this.live()) return;
    const size = estimatedBytes ?? JSON.stringify(tool).length * 3;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 196608 || tool.stepIndex === undefined)
      throw new RangeError("Tool preview exceeds the delivery budget or has no step index");
    this.tools.set(tool.stepIndex, {tool, size});
    this.schedule();
  }
  deferState(state: TurnState): void {
    if (!this.live()) return;
    this.state = {...state};this.schedule();
  }
  clearState(): void {this.state = undefined;}
  flush(): void {
    if (this.flushing) return;
    this.cancel();
    if (!this.live()) return;
    const text = this.text, tools = this.tools, state = this.state;
    this.text = new Map();this.tools = new Map();this.state = undefined;
    this.flushing = true;
    try {
      for (const [stepIndex, pending] of text)
        for (const delta of textFragments(pending.text)) {
          if (!this.live()) return;
          this.emit({type: "streamDelta", stepIndex, delta, receivedAt: pending.receivedAt});
        }
      if (state && this.live()) this.emit({type: "turnState", state});
      for (const batch of toolBatches(tools.values())) {
        if (!this.live()) return;
        this.emit({type: "toolUpdates", generation: this.generation(), tools: batch});
      }
    } finally {this.flushing = false;}
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;this.cancel();this.text.clear();this.tools.clear();this.state = undefined;
  }
  stats() {return {textBlocks: this.text.size, toolUpdates: this.tools.size, timerPending: !!this.timerToken, closed: this.closed};}
}
