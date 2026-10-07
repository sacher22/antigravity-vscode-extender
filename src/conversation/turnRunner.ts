import { OperationCancelledError, ProcessExitUnconfirmedError } from "../core/operationErrors";
import {combineOperationFailures, ExecutionClaimReleaseError} from "../core/operationFailures";
import { PLAN_REQUEST_PREFIX } from "./planPolicy";
import { PARALLEL_EXECUTION_INSTRUCTIONS } from "./executionIntent";
import type { AgyProcessManager } from "../core/agyProcessManager";
import type { ConversationRepository } from "./repository";
import type {
  ChatMessage,
  SessionMeta,
  TurnState,
  WebviewMessage,
} from "../core/types";
import type { TurnDiagnostics } from "./turnDiagnostics";

export interface SubmissionTurn {
  cancelled: boolean;
  user: ChatMessage;
  message: ChatMessage;
  state: TurnState;
  diagnostics?: TurnDiagnostics;
  requestId?: string;
}

export interface TurnRunnerPorts {
  process: AgyProcessManager;
  repository: ConversationRepository;
  epoch(): number;
  current(turn: SubmissionTurn): boolean;
  ready(session: SessionMeta, ticket: number): Promise<SessionMeta>;
  stopping(): Promise<void> | undefined;
  terminationPending(): boolean;
  releaseConfirmed(): void;
  runtime(): void;
  finish(status: "aborted" | "failed", error: string): void;
  phase(phase: TurnState["phase"], detail?: string): void;
  snapshot(): void;
  publish(message: WebviewMessage): void;
  persistPartial(): void;
}

export class TurnRunner {
  private waitTimer: ReturnType<typeof setTimeout> | number | undefined;
  private checkpoint: ReturnType<typeof setInterval> | number | undefined;
  private token = 0;

  constructor(private readonly ports: TurnRunnerPorts) {}

  public clear(): void {
    this.token++;
    if (this.waitTimer !== undefined) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
    if (this.checkpoint !== undefined) {
      clearInterval(this.checkpoint);
      this.checkpoint = undefined;
    }
  }

  public async run(
    turn: SubmissionTurn,
    session: SessionMeta,
    ticket: number,
    text: string,
    displayText: string,
    parallelAgents: boolean,
  ): Promise<string> {
    try {
      if (turn.cancelled || ticket !== this.ports.epoch()) {
        throw new OperationCancelledError();
      }
      session = await this.ports.ready(session, ticket);
      turn.diagnostics?.mark("cli-ready");
      if (turn.cancelled || ticket !== this.ports.epoch()) {
        throw new OperationCancelledError();
      }
      if (!!session.planMode !== !!turn.message.isPlanMode) {
        throw new Error("恢复后的执行模式与本轮策略不一致，已阻止发送。 ");
      }
      turn.state.generation = this.ports.process.currentGeneration;
      const tools = this.ports.process.initInfo.tools;
      if (
        parallelAgents &&
        !session.planMode &&
        Array.isArray(tools) &&
        !tools.includes("invoke_subagent")
      ) {
        throw new Error(
          "当前 CLI 没有提供 invoke_subagent，无法执行多 Agent 任务；没有降级为单代理执行。",
        );
      }
      session.messages.push(turn.user);
      if (session.title === "New Conversation") {
        session.title = displayText.slice(0, 40);
      }
      this.ports.phase("submitted");
      this.ports.snapshot();
      await this.ports.process.sendMessage(
        session.planMode
          ? PLAN_REQUEST_PREFIX + text
          : (parallelAgents ? PARALLEL_EXECUTION_INSTRUCTIONS : "") + text,
      ); // Send the user's actual prompt; the CLI loads project rules itself.
      turn.diagnostics?.mark("stdin-submitted");
      turn.user.status = "sent";
      this.ports.repository.saveSession(session, [turn.user.id!]);
      session.draft = "";
      session.attachment = undefined;
      this.ports.repository.saveMetadata(session);
      this.ports.publish({
        type: "sendAccepted",
        requestId: turn.requestId,
        turnId: turn.state.turnId,
      });
      if (!this.ports.current(turn)) {
        return turn.state.turnId;
      }
      this.clear();
      const token = this.token;
      this.waitTimer = setTimeout(() => {
        if (this.token === token && this.ports.current(turn)) {
          this.ports.phase("waiting", "暂时没有新输出；可以停止或转到原生 CLI。");
        }
      }, 30_000);
      this.checkpoint = setInterval(() => {
        if (this.token === token && this.ports.current(turn)) {
          this.ports.persistPartial();
        }
      }, 1000);
      return turn.state.turnId;
    } catch (error) {
      const stopping = this.ports.stopping();
      if (turn.cancelled && stopping) {
        try {
          await stopping;
        } catch (cleanupError) {
          error = cleanupError;
        }
      }
      turn.user.status = "failed";
      let cleanupFailed = false;
      if (this.ports.process.exitConfirmed) {
        try {this.ports.releaseConfirmed();} catch (cleanupError) {
          cleanupFailed = true;
          error = combineOperationFailures(error, cleanupError);
        }
      }
      const cancelled = turn.cancelled && !cleanupFailed &&
        !(error instanceof ProcessExitUnconfirmedError) && !(error instanceof ExecutionClaimReleaseError);
      if (this.ports.terminationPending() || cleanupFailed) {
        this.ports.runtime();
      }
      if (this.ports.current(turn)) {
        this.ports.finish(
          cancelled ? "aborted" : "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.ports.runtime();
      throw cancelled ? new OperationCancelledError() : error;
    }
  }
}
