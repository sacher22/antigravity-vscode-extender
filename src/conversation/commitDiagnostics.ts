interface PendingCommit {
  sessionId: string;
  messageId: string;
  status: string;
  registeredAt: number;
  committed: () => void;
}
/** Bounded terminal-message correlation; no bodies, polling or storage ownership. */
export class CommitDiagnostics {
  private readonly pending = new Map<string, PendingCommit>();
  private expired = 0;
  private evicted = 0;
  constructor(private readonly now = () => performance.now()) {}
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.pending)
      if (!Number.isFinite(now) || now < entry.registeredAt || now - entry.registeredAt >= 300000) {
        this.pending.delete(key);this.expired++;
      }
  }
  watch(sessionId: string, messageId: string, status: string, committed: () => void): void {
    this.prune();
    const registeredAt = this.now();
    if (!Number.isFinite(registeredAt) || registeredAt < 0 || !sessionId || !messageId ||
        !["completed", "failed", "aborted", "permission_denied"].includes(status)) return;
    const key = sessionId + "\0" + messageId;
    while (!this.pending.has(key) && this.pending.size >= 32) {
      this.pending.delete(this.pending.keys().next().value!);this.evicted++;
    }
    this.pending.set(key, {sessionId, messageId, status, registeredAt, committed});
  }
  accept(event: {sessionId: string; messageId: string; status?: string}): void {
    if (!this.pending.size) return;
    this.prune();
    const key = event.sessionId + "\0" + event.messageId;
    const entry = this.pending.get(key);
    if (!entry || event.status !== entry.status) return;
    this.pending.delete(key);
    try {entry.committed();} catch { /* Telemetry cannot fail a storage commit. */ }
  }
  clear(): void {this.pending.clear();}
  stats() {this.prune();return {pending: this.pending.size, expired: this.expired, evicted: this.evicted};}
}
