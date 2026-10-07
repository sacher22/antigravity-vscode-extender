import type { WorkspacePort } from "../adapters/workspaceAdapter";
import type { SessionMeta } from "../core/types";
import type { ExecutionLease } from "./executionLease";
import {
  nativeHistoryWithCursorAsync,
  nativeLogCursorAsync,
} from "./nativeHistory";

export type TerminalLauncher = WorkspacePort["terminal"];

interface ActiveLaunchRecord {
  readonly lease: ExecutionLease;
  completed: boolean;
  terminalClosed: boolean;
  leaseReleased: boolean;
  releasing: boolean;
  releaseFailure?: Error;
  complete?: () => void;
}

export class NativeHandoff {
  private readonly terminal: TerminalLauncher;
  private readonly activeSessions = new Map<string, ActiveLaunchRecord>();

  constructor(terminal: TerminalLauncher);
  constructor(port: { terminal: TerminalLauncher });
  constructor(terminalOrPort: TerminalLauncher | { terminal: TerminalLauncher }) {
    if (typeof terminalOrPort === "function") {
      this.terminal = terminalOrPort;
    } else if (terminalOrPort && typeof terminalOrPort.terminal === "function") {
      this.terminal = terminalOrPort.terminal.bind(terminalOrPort);
    } else {
      throw new TypeError("Terminal launcher function is required.");
    }
  }

  get size(): number { return this.activeSessions.size; }

  has(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  releaseFailure(sessionId: string): Error | undefined {
    return this.activeSessions.get(sessionId)?.releaseFailure;
  }
  retryClosed(sessionId: string): boolean {
    const record = this.activeSessions.get(sessionId);
    if (!record?.terminalClosed || !record.releaseFailure || !record.complete) return false;
    record.complete();
    return true;
  }

  launch(
    sessionId: string,
    lease: ExecutionLease,
    cli: string,
    cwd: string,
    args: string[],
    onClose: (complete: () => void) => void,
  ): void {
    if (this.has(sessionId)) {
      throw new Error("此会话已在原生 CLI 中打开。");
    }

    const record: ActiveLaunchRecord = {
      lease,
      completed: false,
      terminalClosed: false,
      leaseReleased: false,
      releasing: false,
    };

    const releaseOnce = () => {
      if (!record.leaseReleased) {
        lease();
        record.leaseReleased = true;
      }
    };

    const complete = () => {
      if (record.completed || record.releasing) return;
      record.releasing = true;
      try {
        releaseOnce();
        record.completed = true;
        if (this.activeSessions.get(sessionId) === record) {
          this.activeSessions.delete(sessionId);
        }
      } catch (error) {
        record.releaseFailure = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        record.releasing = false;
      }
    };
    record.complete = complete;

    this.activeSessions.set(sessionId, record);

    try {
      lease.markExecutionPending();
      this.terminal(
        cli,
        cwd,
        args,
        () => {
          if (record.terminalClosed) {
            return;
          }
          record.terminalClosed = true;
          if (record.completed) {
            return;
          }
          onClose(complete);
        },
        (pid: number) => {
          if (record.completed || record.terminalClosed || this.activeSessions.get(sessionId) !== record) {
            return;
          }
          lease.bindProcess(pid);
        },
      );
    } catch (error) {
      complete();
      throw error;
    }
  }

  async checkpoint(session: SessionMeta): Promise<void> {
    if (session.cliConversationId) {
      const cursor = await nativeLogCursorAsync(session.cliConversationId);
      session.nativeLogOffsets = {
        ...session.nativeLogOffsets,
        [session.cliConversationId]: cursor.offset,
      };
      session.nativeLogCursors = {
        ...session.nativeLogCursors,
        [session.cliConversationId]: cursor,
      };
    }
  }

  async importHistory(session: SessionMeta): Promise<boolean | undefined> {
    if (
      !session.cliConversationId ||
      !session.nativeLogOffsets ||
      session.nativeLogOffsets[session.cliConversationId] === undefined
    ) {
      return;
    }
    const page = await nativeHistoryWithCursorAsync(
      session.cliConversationId,
      session.nativeLogOffsets[session.cliConversationId],
      session.nativeLogCursors?.[session.cliConversationId],
    );
    const ids = new Set(session.messages.map((m) => m.id));
    for (const m of page.messages) {
      if (!ids.has(m.id)) {
        session.messages.push(m);
      }
    }
    session.nativeLogOffsets[session.cliConversationId] = page.nextOffset;
    session.nativeLogCursors = {
      ...session.nativeLogCursors,
      [session.cliConversationId]: page.cursor,
    };
    return page.hasMore;
  }
}
