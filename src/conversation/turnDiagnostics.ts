/** Monotonic milestones only; no prompts, tool payloads or per-token logging. */
export class TurnDiagnostics {
  private readonly started: number;
  private readonly milestones = new Map<string, number>();
  constructor(
    private readonly id: string,
    private readonly log: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly observed?: (id: string, name: string, elapsedMs: number) => void,
  ) {
    this.started = this.now();
    this.mark("accepted");
  }
  mark(name: string) {
    if (this.milestones.has(name)) return;
    const elapsedMs = Math.max(0, this.now() - this.started);
    this.milestones.set(name, elapsedMs);
    this.observed?.(this.id, name, elapsedMs);
    this.log(
      JSON.stringify({
        diagnostic: "turn-milestone",
        turnId: this.id,
        milestone: name,
        elapsedMs,
      }),
    );
  }
}
