/** Only explicit CLI errors start a watchdog. Slow model/tool execution alone never does. */
export class RecoveryGuard {
  private attempts = 0;
  private seen = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly stop: (reason: string) => void,
    private readonly timeoutMs = 120_000,
    private readonly limit = 3,
  ) {}
  error(stepIndex: number): number | undefined {
    if (this.seen.has(stepIndex)) return;
    this.seen.add(stepIndex);
    if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
    this.attempts++;
    if (this.attempts >= this.limit)
      this.stop(
        `CLI 连续 ${this.attempts} 次报告错误且没有新进展，已停止自动恢复。已完成的工具不会自动重跑；请核对已有文件后明确续接。`,
      );
    else if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.stop(
          "CLI 报告错误后 120 秒没有新进展，已停止等待恢复。已保留已有记录；请核对文件后明确续接。",
        );
      }, this.timeoutMs);
    return this.attempts;
  }
  progress(): void {
    this.attempts = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  dispose(): void {
    this.progress();
    this.seen.clear();
  }
}
