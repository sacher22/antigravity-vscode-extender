import { RecoveryGuard } from "./recoveryGuard";
import { toolOutcome } from "../core/toolPresentation";
import { toolPreview, toolPreviewLimit } from "./toolPreview";
import {
  OperationCancelledError,
  ProcessExitUnconfirmedError,
} from "../core/operationErrors";
import {
  ExecutionClaimReleaseError,
  combineOperationFailures,
  failureText,
} from "../core/operationFailures";
import { persistentDraft } from "../commands/registry";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { AgyProcessManager } from "../core/agyProcessManager";
import { cliCapabilities, requireVerifiedCli } from "../core/cliCapabilities";
import { BinaryResolver } from "../core/binaryResolver";
import { ConversationRepository } from "./repository";
import type { WorkspacePort } from "../adapters/workspaceAdapter";
import {
  AntigravityConfig,
  ChatMessage,
  ResultPayload,
  SessionMeta,
  StepUpdatePayload,
  TurnState,
  WebviewMessage,
} from "../core/types";

import { PLAN_TOOLS } from "../core/planAgent";
import {
  capturePlanApproval,
  assertPlanApproval,
  shouldRecoverPlanRead,
  hasUsableDeniedPlan,
  planAgentMatches,
  PLAN_READ_RECOVERY_PREFIX,
} from "./planPolicy";
import { requestsParallelAgents } from "./executionIntent";
import { TurnDiagnostics } from "./turnDiagnostics";
import { DiagnosticJournal } from "./diagnosticJournal";
import { CommitDiagnostics } from "./commitDiagnostics";
import { TurnDelivery } from "./turnDelivery";
import { TurnRunner } from "./turnRunner";
import type { ExecutionLease } from "./executionLease";
import { AgentRegistry } from "./agents";
import { NativeHandoff } from "./nativeHandoff";
import { executionProfile, ExecutionProfile } from "./executionProfile";
import {
  resolveModel,
  resolveExecutionProfile,
} from "./executionProfileResolver";
import { buildCliArguments } from "../core/cliArguments";
import { schemaValidator } from "../core/schemaValidation";

interface ActiveTurn {
  recoveryGuard?: RecoveryGuard;
  startupAbort: AbortController;
  capabilityCheck?: Promise<unknown>;
  diagnostics?: TurnDiagnostics;
  profile?: ExecutionProfile;
  config: Readonly<AntigravityConfig>;
  state: TurnState;
  session: SessionMeta;
  message: ChatMessage;
  user: ChatMessage;
  blocks: Map<number, string>;
  tools: Map<number, StepUpdatePayload>;
  toolRevisions: Map<number, number>;
  storedTools: Set<number>;
  delivery?: TurnDelivery;
  cancelled: boolean;
  requestId?: string;
  executionFailure?: string;
  planReadRecovery?: boolean;
  recoveryStepOffset?: number;
  validateSchema?: (text: string) => unknown;
}
function compactValue(
  value: unknown,
  depth = 0,
  budget = { nodes: 200 },
): unknown {
  if (budget.nodes-- <= 0 || depth > 5) return "[详情按需加载]";
  if (typeof value === "string") return value.slice(0, 2048);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 40)
      .map((item) => compactValue(item, depth + 1, budget));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, item]) => [
          key.slice(0, 128),
          compactValue(item, depth + 1, budget),
        ]),
    );
  return String(value).slice(0, 256);
}
export class ConversationController extends EventEmitter {
  private readonly processManager: AgyProcessManager;
  private readonly commitDiagnostics = new CommitDiagnostics();
  private readonly messageCommittedListener = (event: {
    sessionId: string;
    messageId: string;
    status?: string;
  }) => this.commitDiagnostics.accept(event);

  private agentRegistry?: AgentRegistry;
  private agentSession?: string;
  private agentsWatching = false;
  get isWatchingAgents() {
    return this.agentsWatching;
  }
  get activeTurnState() {
    return this.turn ? { ...this.turn.state } : undefined;
  }

  private currentSession: SessionMeta | null = null;
  private turn?: ActiveTurn;
  private queuedOperations = 0;
  get canCompactTranscript() {
    return (
      !this.turn &&
      !this.stopping &&
      !this.terminationPending &&
      !this.executionClaimPending &&
      !this.hasNativeHandoff &&
      !this.queuedOperations &&
      !this.nativeHandoff.size
    );
  }
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private stopping?: Promise<void>;
  private creatingSession?: Promise<void>;
  private disposed = false;
  private activeSignature = "";
  private preparedProfile?: ExecutionProfile;
  private lastHandoffMode: "standalone" | "resume" = "resume";
  get nativeHandoffMode() {
    return this.lastHandoffMode;
  }
  private readonly turnRunner: TurnRunner;
  private sequence = 0;
  private releaseLock?: ExecutionLease;
  private releaseFailure?: ExecutionClaimReleaseError;
  private readonly storageErrorListener = () =>
    this.publish({
      type: "error",
      message: "会话记录保存失败，请检查磁盘空间与目录权限。",
    });
  private readonly toolPersistedListener = (event: {
    sessionId: string;
    messageId: string;
    stepIndex: number;
    output: string;
    preview?: string;
  }) => {
    const turn = this.turn;
    if (
      !turn ||
      turn.session.id !== event.sessionId ||
      turn.message.id !== event.messageId
    )
      return;
    const step = turn.tools.get(event.stepIndex);
    if (step?.tool_info?.output !== event.output) return;
    step.tool_info.output = event.preview ?? event.output.slice(0, 2048);
    turn.storedTools.add(event.stepIndex);
  };
  private readonly storagePressureListener = () =>
    this.processManager.setOutputPaused(
      this.sessionStore.writePausedFor(
        this.turn?.session.id || this.currentSession?.id,
      ),
    );
  get canEvict() {
    return (
      !this.turn &&
      !this.stopping &&
      !this.terminationPending &&
      !this.executionClaimPending &&
      !this.hasNativeHandoff &&
      !this.nativeHandoff.size &&
      !this.agentRegistry
        ?.snapshot()
        .some((a) => a.state === "running" || a.state === "unknown")
    );
  }
  private readonly nativeHandoff: NativeHandoff;
  constructor(
    private readonly environment: WorkspacePort,
    private readonly sessionStore: ConversationRepository,
    processManager?: AgyProcessManager,
    observeStorage = true,
    private readonly diagnosticJournal = new DiagnosticJournal(),
  ) {
    super();
    this.nativeHandoff = new NativeHandoff((...args) =>
      this.environment.terminal(...args),
    );
    this.processManager =
      processManager ||
      new AgyProcessManager((message) => this.recordDiagnostic(message));
    this.turnRunner = new TurnRunner({
      process: this.processManager,
      repository: this.sessionStore,
      epoch: () => this.epoch,
      current: (turn) => this.turn === turn,
      ready: (session, ticket) => this.ensureReady(session, ticket),
      stopping: () => this.stopping,
      terminationPending: () => this.terminationPending,
      releaseConfirmed: () => this.releaseExecutionClaim(),
      runtime: () => this.publishRuntime(),
      finish: (status, error) => this.finish(status, undefined, error),
      phase: (phase, detail) => this.phase(phase, detail),
      snapshot: () => this.sendSnapshot(),
      publish: (message) => this.publish(message),
      persistPartial: () => this.persistPartial(),
    });
    this.setupProcessEvents();
    this.processManager.on("spawned", (pid: number) =>
      this.releaseLock?.bindProcess(pid),
    );
    this.processManager.setOutputPaused(sessionStore.writePausedFor());
    sessionStore.on("storagePressure", this.storagePressureListener);
    sessionStore.on("toolOutputPersisted", this.toolPersistedListener);
    sessionStore.on("messageCommitted", this.messageCommittedListener);
    if (observeStorage)
      sessionStore.on("storageError", this.storageErrorListener);
  }
  ownsNativeSession(id: string): boolean {
    return this.nativeHandoff.has(id);
  }
  get executionClaimPending(): boolean {
    return (
      !!this.releaseFailure ||
      !!(
        this.currentSession &&
        this.nativeHandoff.releaseFailure(this.currentSession.id)
      )
    );
  }
  private get executionClaimError(): string | undefined {
    const native =
      this.currentSession &&
      this.nativeHandoff.releaseFailure(this.currentSession.id);
    return (
      this.releaseFailure?.message ||
      (native ? new ExecutionClaimReleaseError(native).message : undefined)
    );
  }
  private releaseExecutionClaim(): void {
    try {
      this.releaseLock?.();
    } catch (error) {
      this.releaseFailure =
        error instanceof ExecutionClaimReleaseError
          ? error
          : new ExecutionClaimReleaseError(error);
      this.publishRuntime();
      throw this.releaseFailure;
    }
    this.releaseLock = undefined;
    this.releaseFailure = undefined;
  }
  get terminationPending() {
    return this.processManager.terminationUnconfirmed;
  }
  markRenderPost(
    turnId: string,
    kind: "firstText" | "completedText" | "restoredText",
  ): void {
    if (this.turn?.state.turnId !== turnId) return;
    const milestone =
      kind === "firstText"
        ? "webview-first-posted"
        : kind === "completedText"
          ? "webview-completed-posted"
          : "webview-restored-posted";
    this.turn.diagnostics?.mark(milestone);
  }
  diagnosticProcessSnapshot() {
    return {
      session: this.diagnosticJournal.pseudonym(
        this.currentSession?.id || "unselected",
      ),
      generation: this.processManager.currentGeneration,
      active: this.processManager.active,
      terminationPending: this.terminationPending,
      executionClaimPending: this.executionClaimPending,
      nativeHandoff: this.hasNativeHandoff,
      commits: this.commitDiagnostics.stats(),
      stderr: this.processManager.stderrDiagnostics,
    };
  }
  get hasNativeHandoff() {
    const session = this.currentSession;
    return (
      !!session &&
      this.sessionStore.hasNativeExecution(
        session.cliConversationId || session.id,
      )
    );
  }
  get currentExecutionProfile() {
    return this.turn?.profile || this.preparedProfile;
  }
  get processing(): boolean {
    return !!this.turn;
  }
  get currentSessionMeta(): SessionMeta | null {
    return this.currentSession;
  }
  getConfig(): AntigravityConfig {
    const config = this.environment.config();
    return {
      ...config,
      dangerouslySkipPermissions:
        this.currentSession?.dangerouslySkipPermissions ??
        config.dangerouslySkipPermissions,
    };
  }
  recordDiagnostic(message: string): void {
    this.environment.log(
      message.replace(
        /((?:api[_-]?key|token|authorization|password)\s*[=:]\s*)\S+/gi,
        "$1<redacted>",
      ),
    );
  }
  private publish(message: WebviewMessage): void {
    if (message.type === "toolUpdate" && this.turn) {
      const parameters =
        message.toolInfo?.parameters &&
        (compactValue(message.toolInfo.parameters) as Record<string, unknown>);
      const item = {
        stepIndex: message.stepIndex,
        name: message.toolName,
        state: message.state,
        parameters,
        output: message.toolInfo?.output,
        outputRevision: message.outputRevision,
      };
      let size = JSON.stringify(item).length * 3;
      if (size > 32768 * 3) {
        item.parameters = { preview: "参数过长，请按需展开详情。" };
        size = JSON.stringify(item).length * 3;
      }
      this.deliveryFor(this.turn).replaceTool(item, size);
      return;
    }
    this.emit("message", {
      sessionId: this.currentSession?.id,
      turnId: this.turn?.state.turnId,
      generation: this.processManager.currentGeneration,
      ...message,
      sequence: ++this.sequence,
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    this.queuedOperations++;
    const next = this.queue.then(async () => {
      if (this.stopping) await this.stopping;
      if (this.disposed) throw new Error("Extension disposed");
      return work();
    });
    const completed = next.finally(() => {
      this.queuedOperations--;
    });
    this.queue = completed.catch(() => undefined);
    return completed;
  }
  private requireIdle(): void {
    if (this.hasNativeHandoff)
      throw new Error(
        "此会话已在原生 CLI 中打开，请先关闭其终端再操作侧栏。新建对话可以继续使用。",
      );
    if (this.terminationPending) throw new ProcessExitUnconfirmedError();
    if (this.executionClaimPending) throw new Error(this.executionClaimError);
    if (this.turn || this.stopping)
      throw new Error(
        "当前对话正在运行，请先停止当前轮次再更改运行设置或发送消息。",
      );
  }
  private workspaceFor(session?: SessionMeta): {
    root?: string;
    directories: string[];
  } {
    const workspace = this.environment.workspace(session);
    return {
      ...workspace,
      directories: Array.from(
        new Set([
          ...workspace.directories,
          ...(session?.extraDirectories || []),
          ...(session?.imageDirectory ? [session.imageDirectory] : []),
        ]),
      ),
    };
  }
  private activateSession(session: SessionMeta): SessionMeta {
    if (session.dangerouslySkipPermissions === undefined) {
      session.dangerouslySkipPermissions =
        this.environment.config().dangerouslySkipPermissions;
      session.permissionSource = "migrated-default";
      this.sessionStore.saveSession(session);
    }
    let previousUser = "";
    for (const m of session.messages.slice(-30)) {
      if (m.role === "user") previousUser = m.content;
      else if (
        m.isPlanMode &&
        !m.agentExecution &&
        requestsParallelAgents(previousUser)
      )
        m.agentExecution = { required: 2, observedIds: [], state: "planned" };
    }
    if (this.agentSession !== session.id) {
      this.agentRegistry?.dispose();
      this.agentSession = session.id;
      this.agentRegistry = new AgentRegistry(
        session.agents || [],
        (persist = true) => {
          session.agents = this.agentRegistry!.snapshot();
          if (persist) this.sessionStore.saveMetadata(session);
          this.publishAgents();
        },
      );
    }
    this.currentSession = session;
    this.sessionStore.setCurrentSessionId(session.id);
    return session;
  }
  private createDraft(previous?: SessionMeta, restoring = false): SessionMeta {
    const config = this.getConfig();
    const workspace = this.workspaceFor();
    const session = this.sessionStore.createSession(
      "sess_" + randomUUID(),
      previous?.model || config.defaultModel,
      previous?.effort || config.reasoningEffort,
    );
    session.dangerouslySkipPermissions =
      previous?.dangerouslySkipPermissions ?? config.dangerouslySkipPermissions;
    session.permissionSource = "inherited";
    session.planMode = restoring ? !!previous?.planMode : false;
    if (restoring) {
      session.customAgent = previous?.customAgent;
      session.sandbox = previous?.sandbox;
      session.schemaPath = previous?.schemaPath;
      session.planAgentVersion = previous?.planAgentVersion;
    }
    session.workspaceRoot = workspace.root;
    session.workspaceDirectories = workspace.directories;
    this.sessionStore.saveSession(session);
    return this.activateSession(session);
  }
  private selectSession(id?: string): SessionMeta {
    const session = id
      ? this.sessionStore.getSession(id)
      : this.currentSession ||
        this.sessionStore.getSession(
          this.sessionStore.getCurrentSessionId() || "",
        );
    if (id && !session) throw new Error("会话不存在。");
    return session ? this.activateSession(session) : this.createDraft();
  }
  /** Restore an existing selection only; creating a conversation has a separate entry point. */
  prepareOrSwitchSessionUI(id?: string): SessionMeta {
    if (id && id !== this.currentSession?.id) this.requireIdle();
    return this.selectSession(id);
  }
  newSession(force = false): Promise<void> {
    if (this.creatingSession) return this.creatingSession;
    this.creatingSession = (async () => {
      await this.abortTurn();
      await this.serial(async () => {
        const previous = this.currentSession;
        if (force || !this.sessionStore.isEmptySession(previous || undefined))
          this.createDraft(previous || undefined);
        else if (previous) {
          previous.planMode = false;
          const workspace = this.workspaceFor();
          previous.workspaceRoot = workspace.root;
          previous.workspaceDirectories = workspace.directories;
          this.sessionStore.saveSession(previous);
        } else this.createDraft();
        this.sendSnapshot();
      });
    })().finally(() => {
      this.creatingSession = undefined;
    });
    return this.creatingSession;
  }
  async switchSession(id: string): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      await this.processManager.stop();
      this.releaseExecutionClaim();
      this.activeSignature = "";
      this.selectSession(id);
      this.sendSnapshot();
    });
  }
  async deleteSession(id: string): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      if (this.currentSession?.id === id) {
        await this.processManager.stop();
        this.releaseExecutionClaim();
        this.activeSignature = "";
      }
      await this.sessionStore.deleteSession(id);
      if (this.currentSession?.id === id) this.currentSession = null;
      this.selectSession();
      this.sendSnapshot();
    });
  }
  private compactMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      blocks: message.blocks?.map((block) => ({ ...block, text: block.text })),
      toolCalls: message.toolCalls?.map((tool) => ({
        ...tool,
        output:
          tool.output === undefined
            ? undefined
            : toolPreview(
                tool.output,
                toolPreviewLimit(message.toolCalls?.length || 0),
              ),
        parameters: tool.parameters
          ? (compactValue(tool.parameters) as Record<string, unknown>)
          : undefined,
      })),
    };
  }
  sendSnapshot(): void {
    if (this.turn) this.updateTranscript();
    const s = this.currentSession || this.selectSession();
    const messages = s.messages
      .filter((m) => m.id !== this.turn?.message.id)
      .slice(-30)
      .map((m) => this.compactMessage(m));
    const activeTurn = this.turn
      ? {
          state: { ...this.turn.state },
          message: this.compactMessage(this.turn.message),
        }
      : undefined;
    this.publish({
      type: "initSession",
      session: { ...s, messages },
      config: this.getConfig(),
      activeTurn,
      hasMore: (s.messageCount || s.messages.length) > 30,
    });
    this.publish({
      type: "sessionList",
      sessions: this.sessionStore
        .getAllSessions()
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      currentId: s.id,
    });
    this.publishRuntime();
    this.publishAgents();
  }
  loadHistory(before: number): Promise<void> {
    const s = this.currentSession;
    return this.serial(async () => {
      if (!s) return;
      const page = await this.sessionStore.pageAsync(s.id, before);
      if (this.currentSession !== s) return;
      this.publish({
        type: "historyPage",
        messages: page.messages.map((m) => this.compactMessage(m)),
        hasMore: page.hasMore,
      });
    });
  }

  async toolDetail(
    messageId: string | undefined,
    index: number,
    offset = 0,
  ): Promise<void> {
    const active = this.turn;
    const session = this.currentSession;
    if (active) this.updateTranscript();
    const tool =
      active && messageId === active.message.id
        ? active.message.toolCalls?.find((t) => t.stepIndex === index)
        : messageId
          ? this.currentSession?.messages
              .find((m) => m.id === messageId)
              ?.toolCalls?.find((t) => t.stepIndex === index)
          : active?.message.toolCalls?.find((t) => t.stepIndex === index);
    if (tool) {
      let page;
      if (
        active &&
        messageId === active.message.id &&
        tool.output !== undefined &&
        !this.sessionStore.isToolPreview(tool)
      ) {
        const bytes = Buffer.from(tool.output, "utf8");
        let end = Math.min(bytes.length, offset + 65536);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (let trim = 0; trim < 4; trim++) {
          try {
            decoder.decode(bytes.subarray(offset, end));
            break;
          } catch {
            end--;
          }
        }
        page = {
          output: bytes.subarray(offset, end).toString("utf8"),
          nextOffset: end,
          hasMore: end < bytes.length,
        };
      } else if (messageId && session) {
        await this.sessionStore.flush();
        page = await this.sessionStore.toolOutputAsync(
          session.id,
          messageId,
          index,
          offset,
        );
      }
      if (this.currentSession !== session) return;
      this.publish({
        type: "toolDetail",
        outputRevision: tool.outputRevision,
        stepIndex: index,
        requestId: messageId,
        toolInfo: {
          name: tool.name,
          parameters: tool.parameters,
          output: page?.output || tool.output,
        },
        nextOffset: page?.nextOffset,
        hasMore: page?.hasMore,
      });
    }
  }
  async saveDraft(
    text: string,
    attachment?: SessionMeta["attachment"],
  ): Promise<void> {
    const s = this.currentSession || this.selectSession();
    s.draft = persistentDraft(text);
    s.attachment = attachment;
    this.sessionStore.saveDraftMetadata(s);
    await this.sessionStore.flush();
  }
  private publishRuntime(): void {
    const s = this.currentSession;
    if (!s) return;
    const c = this.getConfig();
    const r = resolveModel(s.model, s.effort);
    this.publish({
      type: "runtime",
      workspaceRoot: this.workspaceFor(s).root,
      model: String(
        (this.processManager.active && this.processManager.initInfo.model) ||
          r.effectiveModel,
      ),
      permission: String(
        this.processManager.active
          ? this.processManager.initInfo.permission_mode ||
              (c.dangerouslySkipPermissions ? "auto" : "review")
          : s.planMode
            ? "只读工具"
            : c.dangerouslySkipPermissions
              ? "auto"
              : "review",
      ),
      planMode: !!s.planMode,
      terminationPending: this.terminationPending,
      executionClaimPending: this.executionClaimPending,
      executionClaimError: this.executionClaimError,
      nativeHandoff: this.hasNativeHandoff,
    });
  }
  private async requireWorkspace(
    session: SessionMeta,
    ticket: number,
  ): Promise<{ root: string; directories: string[] }> {
    const workspace = this.workspaceFor(session);
    if (ticket !== this.epoch || this.disposed)
      throw new OperationCancelledError();
    if (!workspace.root) throw new Error("请先在 VS Code 打开文件夹。");
    if (!fs.statSync(workspace.root).isDirectory())
      throw new Error("VS Code 当前项目目录不存在，请重新打开文件夹。");
    return { root: workspace.root, directories: workspace.directories };
  }
  private async ensureReady(
    session: SessionMeta,
    ticket: number,
  ): Promise<SessionMeta> {
    const workspace = await this.requireWorkspace(session, ticket);
    if (session.planMode && session.planAgentVersion !== 1) {
      session.normalCliConversationId ||= session.cliConversationId;
      session.cliConversationId = undefined;
      session.planCliConversationId = undefined;
      session.planAgentVersion = 1;
    }
    if (
      session.workspaceRoot &&
      path.resolve(session.workspaceRoot) !== workspace.root
    ) {
      session = this.createDraft(session, true);
      if (this.turn) {
        this.turn.session = session;
        this.turn.state.sessionId = session.id;
      }
      this.publish({
        type: "notice",
        message: "该历史会话属于其他项目，已在当前工作区新建对话。",
      });
    }
    if (ticket !== this.epoch) throw new OperationCancelledError();
    const c = this.turn?.config || Object.freeze({ ...this.getConfig() });
    const cli = await BinaryResolver.resolveCliPath(c.cliPath);
    let profile = resolveExecutionProfile({
      session,
      config: c,
      cliPath: cli,
      workspace,
      capabilities: this.processManager.active
        ? this.preparedProfile?.capabilities
        : undefined,
    });
    this.preparedProfile = profile;
    if (this.turn) this.turn.profile = profile;
    const signature = () => JSON.stringify([session.id, profile.signature]);
    if (this.nativeHandoff.has(session.id))
      throw new Error("此会话已交给原生 CLI。关闭其终端后可从会话列表恢复。");
    if (this.processManager.active && this.activeSignature === signature())
      return session;
    if (ticket !== this.epoch) throw new OperationCancelledError();
    this.turn?.diagnostics?.mark("capability-check-start");
    const turn = this.turn;
    const capabilityCheck = cliCapabilities.discover(
      cli,
      workspace.root,
      turn?.startupAbort.signal,
    );
    if (turn) turn.capabilityCheck = capabilityCheck;
    const capabilities = await capabilityCheck;
    this.turn?.diagnostics?.mark("capability-check-end");
    if (ticket !== this.epoch || this.disposed)
      throw new OperationCancelledError();
    profile = Object.freeze({ ...profile, capabilities });
    this.preparedProfile = profile;
    if (this.turn) this.turn.profile = profile;
    requireVerifiedCli(capabilities);
    if (this.releaseLock || this.terminationPending)
      await this.processManager.stop();
    this.releaseExecutionClaim();
    this.releaseLock = this.sessionStore.acquireExecution(
      session.cliConversationId || session.id,
    );
    this.releaseLock.markExecutionPending();
    const id = await this.processManager.start(profile.options);
    if (ticket !== this.epoch) {
      await this.processManager.stop();
      throw new OperationCancelledError();
    }
    if (
      !planAgentMatches(!!session.planMode, this.processManager.initInfo.agent)
    ) {
      await this.processManager.stop();
      throw new Error("CLI 未启用只读 Plan Agent，已阻止发送任务。");
    }
    const actualRoot = this.processManager.initInfo.cwd;
    if (
      (typeof actualRoot === "string" &&
        path.resolve(actualRoot) !== workspace.root) ||
      (!!session.cliConversationId &&
        !session.workspaceRoot &&
        typeof actualRoot !== "string")
    ) {
      await this.processManager.stop();
      if (!session.cliConversationId)
        throw new Error("CLI 未使用 VS Code 当前项目目录。");
      const fresh = this.createDraft(session, true);
      if (this.turn) {
        this.turn.session = fresh;
        this.turn.state.sessionId = fresh.id;
      }
      this.publish({
        type: "notice",
        message:
          "旧会话的项目目录无法匹配，已在当前工作区新建对话并保留原历史。",
      });
      return this.ensureReady(fresh, ticket);
    }
    session.workspaceRoot = workspace.root;
    session.workspaceDirectories = workspace.directories;
    if ((session.cliConversationId || session.id) !== id) {
      const previous = this.releaseLock;
      try {
        const next = this.sessionStore.acquireExecution(id);
        // Keep both claims until the destination has durable process provenance.
        // If binding or cleanup fails, the normal confirmed-exit path releases
        // this combined lease; neither alias can run while exit is uncertain.
        this.releaseLock = Object.assign(
          () => {
            next();
            previous?.();
          },
          {
            markExecutionPending: () => next.markExecutionPending(),
            bindProcess: (pid: number) => next.bindProcess(pid),
          },
        );
        next.markExecutionPending();
        if (!this.processManager.processPid)
          throw new Error("CLI 进程已退出，无法转移执行归属。");
        next.bindProcess(this.processManager.processPid);
        previous?.();
        this.releaseLock = next;
      } catch (error) {
        await this.processManager.stop();
        throw error;
      }
    }
    session.cliConversationId = id;
    this.sessionStore.saveSession(session);
    if (this.turn) {
      this.turn.state.sessionId = session.id;
      this.turn.state.generation = this.processManager.currentGeneration;
    }
    this.activeSignature = signature();
    this.sendSnapshot();
    return session;
  }
  async sendMessage(
    text: string,
    requestId?: string,
    displayText = text,
    parallelAgents = requestsParallelAgents(text),
    verifiedSkill = false,
  ): Promise<string> {
    this.requireIdle();
    if (!text.trim()) throw new Error("消息不能为空。");
    if (
      text.trim().startsWith("/") &&
      !text.trim().startsWith("//") &&
      !verifiedSkill
    )
      throw new Error("侧栏暂不执行未验证的斜杠命令，请使用原生 CLI。");
    let session = this.currentSession || this.selectSession();
    // Execution owns the draft before any async startup/protocol check. UI
    // autosave may not have fired yet, and a rebuilding view must recover it.
    if (!session.draft) {
      session.draft = persistentDraft(displayText);
      this.sessionStore.saveMetadata(session);
    }
    const user: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: displayText,
      images: session.attachment?.items?.flatMap((item) =>
        item.image ? [item.image] : [],
      ),
      timestamp: Date.now(),
      status: "pending",
    };
    const message: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: "",
      timestamp: Date.now() + 1,
      status: "running",
      isPlanMode: !!session.planMode,
      structuredOutput: !!session.schemaPath && !session.planMode,
      agentExecution: parallelAgents
        ? {
            required: 2,
            observedIds: [],
            state: session.planMode ? "planned" : "waiting",
          }
        : undefined,
      blocks: [],
      toolCalls: [],
    };
    const turn: ActiveTurn = {
      startupAbort: new AbortController(),
      config: Object.freeze({ ...this.getConfig() }),
      state: {
        turnId: randomUUID(),
        sessionId: session.id,
        generation: this.processManager.currentGeneration,
        phase: "connecting",
        startedAt: Date.now(),
      },
      session,
      user,
      message,
      blocks: new Map(),
      tools: new Map(),
      toolRevisions: new Map(),
      storedTools: new Set(),
      cancelled: false,
      validateSchema:
        session.schemaPath && !session.planMode
          ? schemaValidator(session.schemaPath)
          : undefined,
      requestId,
    };
    turn.diagnostics = new TurnDiagnostics(
      turn.state.turnId,
      (message) => this.recordDiagnostic(message),
      () => performance.now(),
      (id, name, elapsedMs) =>
        this.diagnosticJournal.record(id, name, elapsedMs, requestId),
    );
    this.turn = turn;
    this.storagePressureListener();
    const ticket = this.epoch;
    this.publish({ type: "turnState", state: { ...turn.state } });
    return this.serial(() =>
      this.turnRunner.run(
        turn,
        session,
        ticket,
        text,
        displayText,
        parallelAgents,
      ),
    );
  }
  private persistPartial(): void {
    const t = this.turn;
    if (!t || !t.session.messages.includes(t.user)) return;
    this.updateTranscript();
    if (!t.session.messages.includes(t.message))
      t.session.messages.push(t.message);
    this.sessionStore.saveSession(t.session, [t.user.id!, t.message.id!]);
  }
  private updateTranscript(): void {
    const t = this.turn;
    if (!t) return;
    t.message.blocks = Array.from(t.blocks, ([stepIndex, text]) => ({
      stepIndex,
      text,
    }));
    t.message.content = t.message.blocks.map((b) => b.text).join("");
    t.message.toolCalls = Array.from(t.tools.values()).map((step) => {
      const tool = {
        stepIndex: step.step_index,
        name: step.tool_name!.slice(0, 256),
        outputRevision: t.toolRevisions?.get(step.step_index),
        state: step.state,
        parameters: step.tool_info?.parameters,
        output: step.tool_info?.output,
        outcome: toolOutcome(step.tool_info?.output),
      };
      if (t.storedTools.has(step.step_index))
        this.sessionStore.markToolPreview(tool);
      return tool;
    });
  }
  private phase(phase: TurnState["phase"], detail?: string): void {
    const t = this.turn;
    if (!t || (t.state.phase === phase && t.state.detail === detail)) return;
    if (phase === "tool" && t.state.phase === "tool") {
      t.state.detail = detail;
      this.deliveryFor(t).deferState(t.state);
      return;
    }
    t.delivery?.clearState();
    t.diagnostics?.mark(phase);
    t.state.phase = phase;
    t.state.detail = detail;
    this.publish({ type: "turnState", state: { ...t.state } });
  }
  private deliveryFor(turn: ActiveTurn): TurnDelivery {
    return (turn.delivery ||= new TurnDelivery(
      (message) => this.publish(message),
      () => turn.state.generation,
      () => this.turn === turn,
    ));
  }
  private flushDeltas(): void {
    this.turn?.delivery?.flush();
  }
  private valid(generation: number, conversation?: string): boolean {
    return (
      !!this.turn &&
      !this.turn.cancelled &&
      generation === this.turn.state.generation &&
      (!conversation || conversation === this.turn.session.cliConversationId)
    );
  }
  private setupProcessEvents(): void {
    this.processManager.on(
      "step_update",
      (step: StepUpdatePayload, generation: number, receivedAt: number) => {
        if (!this.valid(generation, step.conversation_id)) return;
        const t = this.turn!;
        if (t.recoveryStepOffset)
          step = {
            ...step,
            step_index: step.step_index + t.recoveryStepOffset,
          };
        if (step.step_type === "error_message") {
          this.flushDeltas();
          const guard = (t.recoveryGuard ||= new RecoveryGuard((reason) => {
            if (this.turn !== t || t.cancelled) return;
            t.executionFailure = reason;
            void this.abortTurn().catch((error) =>
              this.publish({ type: "error", message: error.message }),
            );
          }));
          const attempt = guard.error(step.step_index);
          if (attempt !== undefined) {
            const text = `CLI 报告错误（连续 ${attempt} 次）；尚无新进展。${attempt >= 3 ? "正在停止自动恢复。" : "正在等待 CLI 恢复或最终结果，可随时停止。"}`;
            (t.message.executionNotices ||= []).push({
              stepIndex: step.step_index,
              text,
            });
            this.publish({
              type: "executionNotice",
              stepIndex: step.step_index,
              text,
            });
            if (!t.cancelled) this.phase("waiting", text);
          }
          return;
        }
        if (step.step_type === "agent_response" && step.text_delta)
          t.recoveryGuard?.progress();
        if (step.step_type === "tool") {
          const old = t.tools.get(step.step_index);
          if (
            !old ||
            old.state !== step.state ||
            (step.tool_info?.output !== undefined &&
              old.tool_info?.output !== step.tool_info.output)
          )
            t.recoveryGuard?.progress();
        }
        const execution = t.message.agentExecution;
        if (execution && !t.session.planMode) {
          const before = execution.observedIds.length;
          for (const a of step.subagent_info?.subagents || []) {
            if (
              /^[a-zA-Z0-9_-]{1,128}$/.test(a.conversation_id || "") &&
              !execution.observedIds.includes(a.conversation_id)
            )
              execution.observedIds.push(a.conversation_id);
          }
          if (execution.observedIds.length >= execution.required)
            execution.state = "started";
          if (before !== execution.observedIds.length) this.sendSnapshot();
          if (
            execution.state !== "started" &&
            step.tool_name &&
            !PLAN_TOOLS.has(step.tool_name) &&
            !["invoke_subagent", "manage_subagents"].includes(step.tool_name)
          ) {
            execution.state = "not_started";
            t.tools.set(step.step_index, {
              ...step,
              tool_info: step.tool_info
                ? {
                    ...step.tool_info,
                    parameters: compactValue(
                      step.tool_info.parameters,
                    ) as Record<string, unknown>,
                    output: step.tool_info.output?.slice(0, 2048),
                  }
                : undefined,
            });
            t.executionFailure =
              "未按多 Agent 并行要求执行：CLI 尚未确认至少两个子代理，就开始使用主代理执行工具。已请求停止，请核对已有工具结果后重试。";
            void this.abortTurn();
            return;
          }
        }
        this.agentRegistry?.ingest(step);
        if (
          t.session.planMode &&
          ((step.step_type === "tool" &&
            step.tool_name &&
            !PLAN_TOOLS.has(step.tool_name)) ||
            step.step_type === "subagent")
        ) {
          void this.abortTurn();
          this.publish({
            type: "error",
            message:
              "Plan Agent 返回了未允许的执行工具，已停止。请检查 CLI 版本与 Agent 配置。",
          });
          return;
        }
        if (step.step_type === "agent_response" && step.text_delta) {
          t.diagnostics?.mark("first-cli-text");
          t.blocks.set(
            step.step_index,
            (t.blocks.get(step.step_index) || "") + step.text_delta,
          );
          this.deliveryFor(t).appendText(
            step.step_index,
            step.text_delta,
            receivedAt,
          );
          this.phase("responding");
        }
        if (step.step_type === "agent_response" && step.state !== "ACTIVE") {
          this.flushDeltas();
          this.publish({ type: "stepDone", stepIndex: step.step_index });
        }
        if (step.step_type === "tool" && step.tool_name) {
          const old = t.tools.get(step.step_index);
          const incoming = step.tool_info;
          if (
            incoming?.output !== undefined &&
            incoming.output !== old?.tool_info?.output
          ) {
            t.storedTools.delete(step.step_index);
            t.toolRevisions.set(
              step.step_index,
              (t.toolRevisions.get(step.step_index) || 0) + 1,
            );
          }
          const saved = {
            ...step,
            tool_info: { name: step.tool_name, ...old?.tool_info, ...incoming },
          };
          t.tools.set(step.step_index, saved);
          this.phase("tool", step.tool_name);
          this.publish({
            type: "toolUpdate",
            outputRevision: t.toolRevisions.get(step.step_index),
            stepIndex: step.step_index,
            toolName: step.tool_name,
            state: step.state,
            outcome: toolOutcome(saved.tool_info?.output),
            toolInfo: {
              name: step.tool_name,
              parameters: saved.tool_info?.parameters
                ? Object.fromEntries(
                    Object.entries(saved.tool_info.parameters).map(([k, v]) => [
                      k,
                      typeof v === "string" ? v.slice(0, 2048) : v,
                    ]),
                  )
                : undefined,
              output: saved.tool_info?.output?.slice(0, 2048),
            },
          });
        }
        // system_message is not a permission request or a reliable end-of-turn marker.
      },
    );
    this.processManager.on(
      "result",
      (result: ResultPayload, generation: number, receivedAt: number) => {
        if (!this.valid(generation, result.conversation_id)) return;
        const t = this.turn!;
        if (
          shouldRecoverPlanRead(
            !!t.session.planMode,
            !!t.planReadRecovery,
            t.message.content,
            result,
          )
        ) {
          this.flushDeltas();
          this.updateTranscript();
          t.planReadRecovery = true;
          t.recoveryStepOffset =
            Math.max(0, ...t.tools.keys(), ...t.blocks.keys()) + 1;
          t.message.permissionRequests = result.denied_actions!.map((d) => ({
            action: d.action,
            displayName: d.display_name,
          }));
          this.phase(
            "waiting",
            "CLI 自动拒绝了读取；正在根据已有信息整理方案。",
          );
          // One continuation in the same restricted process and UI turn. Never grant permissions.
          void this.processManager
            .sendMessage(PLAN_READ_RECOVERY_PREFIX + t.user.content)
            .catch((e) => {
              if (this.turn === t && !t.cancelled)
                this.finish(
                  "failed",
                  undefined,
                  "读取被 CLI 自动拒绝，方案续写失败：" + e.message,
                );
            });
          return;
        }
        this.finish(
          result.status === "SUCCESS" ? "completed" : "failed",
          result,
          result.error,
          receivedAt,
        );
      },
    );
    this.processManager.on(
      "agy_error",
      (e: { message?: string }, generation: number) => {
        if (this.valid(generation))
          this.finish(
            "failed",
            undefined,
            e?.message || "CLI reported an error",
          );
      },
    );
    this.processManager.on("error", (e: Error, generation: number) => {
      if (this.valid(generation)) this.finish("failed", undefined, e.message);
    });
    this.processManager.on("exit", (info) => {
      this.activeSignature = "";
      let cleanupError: Error | undefined;
      if (this.processManager.exitConfirmed) {
        try {
          this.releaseExecutionClaim();
        } catch (error) {
          cleanupError = error as Error;
          this.publish({ type: "error", message: cleanupError.message });
        }
      }
      this.publishRuntime();
      if (this.valid(info.generation))
        this.finish(
          "failed",
          undefined,
          `CLI 意外退出 (${info.code ?? info.signal})${cleanupError ? "；" + cleanupError.message : ""}`,
        );
    });
    this.processManager.on("custom_event", (name: string) =>
      this.recordDiagnostic(`unknown event type=${name}`),
    );
  }
  private finish(
    status: "completed" | "failed" | "aborted",
    result?: ResultPayload,
    error?: string,
    receivedAt?: number,
  ): void {
    const t = this.turn;
    if (!t) return;
    this.flushDeltas();
    this.turnRunner.clear();
    t.recoveryGuard?.dispose();
    this.updateTranscript();
    this.agentRegistry?.rootFinished();
    let finalTextChanged = false;
    if (!t.message.content && result?.response) {
      t.message.content = result.response;
      t.message.blocks = [
        {
          stepIndex: Math.max(-1, ...t.tools.keys(), ...t.blocks.keys()) + 1,
          text: result.response,
        },
      ];
      finalTextChanged = true;
    }
    if (
      t.message.structuredOutput &&
      result?.response &&
      status === "completed"
    ) {
      try {
        t.message.content = JSON.stringify(
          t.validateSchema
            ? t.validateSchema(result.response)
            : JSON.parse(result.response),
          null,
          2,
        );
        t.message.blocks = undefined;
        finalTextChanged = true;
      } catch (validationError) {
        status = "failed";
        error = (validationError as Error).message;
      }
    }
    const execution = t.message.agentExecution;
    if (
      execution &&
      !t.session.planMode &&
      status === "completed" &&
      execution.state !== "started"
    ) {
      execution.state = "not_started";
      t.executionFailure = `未按多 Agent 并行要求执行：本轮仅确认 ${execution.observedIds.length} 个子代理，要求至少 ${execution.required} 个。没有将方案里的角色名称计为子代理。`;
    }
    if (
      execution &&
      !t.session.planMode &&
      ["aborted", "failed"].includes(status) &&
      execution.state === "waiting"
    )
      execution.state = "not_started";
    if (t.executionFailure) {
      status = "failed";
      error = t.executionFailure;
    }
    t.diagnostics?.mark("execution-ended");
    const unfinished = (t.message.toolCalls || []).filter(
      (tool) => tool.state === "ACTIVE",
    );
    for (const tool of unfinished) {
      tool.state = "DONE";
      tool.outcome = status === "aborted" ? "cancelled" : "unknown";
    }
    if (unfinished.length)
      this.publish({ type: "toolUpdates", tools: unfinished });
    if (!t.message.content && status !== "completed") {
      const stepIndex =
        Math.max(
          -1,
          ...t.tools.keys(),
          ...(t.message.executionNotices || []).map((n) => n.stepIndex),
        ) + 1;
      const text = `扩展状态：本轮${status === "aborted" ? "已停止" : "失败"}，记录了 ${t.tools.size} 次工具调用，尚无模型正文或交付验收结论。请核对已有文件后续接；扩展不会自动重跑这些工具。`;
      (t.message.executionNotices ||= []).push({ stepIndex, text });
    }
    t.message.status = status;
    t.message.error = error;
    t.message.usage = result?.usage;
    t.message.durationSeconds = (Date.now() - t.state.startedAt) / 1000;
    if (result?.denied_actions?.length) {
      const usablePlan = hasUsableDeniedPlan(
        !!t.session.planMode,
        t.message.content,
        status,
        result,
      );
      t.message.status = usablePlan ? "completed" : "permission_denied";
      t.message.permissionRequests = result.denied_actions.map((d) => ({
        action: d.action,
        displayName: d.display_name,
      }));
      t.message.error = usablePlan
        ? undefined
        : "CLI 已自动拒绝工具操作（不是用户拒绝，也没有待审批请求）。可转到原生 CLI 重试并按提示确认。";
      for (const tool of t.message.toolCalls || [])
        if (
          result.denied_actions.some(
            (d) => d.action === "command" && tool.name === "run_command",
          )
        )
          tool.state = "FAILED";
    }
    if (t.session.messages.includes(t.user)) {
      if (!t.session.messages.includes(t.message))
        t.session.messages.push(t.message);
      t.session.updatedAt = Date.now();
      const cumulative = result?.usage?.total_tokens;
      if (cumulative !== undefined) {
        const id = t.session.cliConversationId || t.session.id;
        const totals = (t.session.cliUsageTotals ||= {});
        t.session.totalTokens += Math.max(0, cumulative - (totals[id] || 0));
        totals[id] = cumulative;
      }
      const diagnostics = t.diagnostics;
      this.commitDiagnostics.watch(
        t.session.id,
        t.message.id!,
        t.message.status!,
        () => diagnostics?.mark("storage-committed"),
      );
      this.sessionStore.saveSession(t.session, [t.user.id!, t.message.id!]);
    }
    this.phase(
      t.message.status === "permission_denied"
        ? "permission_denied"
        : status === "completed"
          ? "completed"
          : status === "aborted"
            ? "aborted"
            : "failed",
      t.message.error,
    );
    this.publish({
      type: "turnComplete",
      receivedAt,
      // The streamed body is already in the view. Avoid retransmitting it and
      // thousands of unchanged tools on the completion path.
      result: {
        ...(result || {
          status: status === "failed" ? "ERROR" : "SUCCESS",
          duration_seconds: (Date.now() - t.state.startedAt) / 1000,
          error: t.message.error,
        }),
        response: undefined,
      },
      usage: result?.usage,
      messageId: t.message.id,
      changes: {
        executionNotices: t.message.executionNotices,
        status: t.message.status,
        error: t.message.error,
        usage: t.message.usage,
        durationSeconds: t.message.durationSeconds,
        permissionRequests: t.message.permissionRequests,
        agentExecution: t.message.agentExecution,
        structuredOutput: t.message.structuredOutput,
        ...(finalTextChanged
          ? { content: t.message.content, blocks: t.message.blocks || [] }
          : {}),
        ...(result?.denied_actions?.length
          ? { toolCalls: this.compactMessage(t.message).toolCalls }
          : {}),
      },
      sessionSummary: {
        updatedAt: t.session.updatedAt,
        totalTokens: t.session.totalTokens,
        messageCount: t.session.messageCount,
      },
    });
    this.recordDiagnostic(
      `turn finish status=${t.message.status} elapsedMs=${Date.now() - t.state.startedAt}`,
    );
    t.delivery?.dispose();
    this.turn = undefined;
    if (t.message.status === "permission_denied")
      this.publish({ type: "error", message: t.message.error! });
    this.publishAgents();
  }
  async abortTurn(): Promise<void> {
    if (this.hasNativeHandoff && !this.disposed) {
      const id = this.currentSession!.id;
      if (!this.nativeHandoff.releaseFailure(id))
        throw new Error(
          "此会话已在原生 CLI 中打开，请在原生终端停止任务；侧栏不会关闭该终端。",
        );
      try {
        this.nativeHandoff.retryClosed(id);
        this.publishRuntime();
      } catch (error) {
        this.publishRuntime();
        throw new ExecutionClaimReleaseError(error);
      }
      return;
    }
    if (this.stopping) return this.stopping;
    ++this.epoch;
    const t = this.turn;
    if (t) {
      t.cancelled = true;
      t.startupAbort.abort();
      this.phase("stopping");
    }
    this.stopping = Promise.all([
      this.processManager.abortCurrentTurn(),
      t?.capabilityCheck?.catch((error) => {
        if (error instanceof ProcessExitUnconfirmedError) throw error;
      }),
    ]).then(() => undefined);
    try {
      await this.stopping;
      this.activeSignature = "";
      if (this.turn === t && t) this.finish("aborted");
      await this.sessionStore.flush();
    } catch (error) {
      // Completion clears the active UI turn. Publish uncertain process
      // ownership first so it cannot briefly expose ordinary Send/settings.
      if (this.terminationPending) this.publishRuntime();
      if (this.turn === t && t)
        this.finish(
          "failed",
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      await this.sessionStore.flush();
      throw error;
    } finally {
      this.stopping = undefined;
      try {
        if (this.processManager.exitConfirmed) this.releaseExecutionClaim();
      } finally {
        this.publishRuntime();
      }
    }
  }
  async setExecutionOptions(
    options: Pick<
      SessionMeta,
      "customAgent" | "sandbox" | "schemaPath" | "extraDirectories"
    >,
  ): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      const s = this.currentSession || this.selectSession();
      if (s.planMode && options.customAgent)
        throw new Error("Plan 固定使用只读 Agent，请先退出 Plan。");
      if (s.planMode && options.schemaPath)
        throw new Error("请先退出 Plan 再设置结构化输出。");
      const prior = {
        customAgent: s.customAgent,
        sandbox: s.sandbox,
        schemaPath: s.schemaPath,
        extraDirectories: s.extraDirectories,
      };
      await this.processManager.stop();
      this.releaseExecutionClaim();
      this.activeSignature = "";
      Object.assign(s, options);
      this.sessionStore.saveSession(s);
      try {
        await this.sessionStore.flush();
      } catch (error) {
        Object.assign(s, prior);
        this.sessionStore.saveSession(s);
        this.sendSnapshot();
        throw error;
      }
      this.sendSnapshot();
    });
  }
  async syncNativeHistory() {
    this.requireIdle();
    return this.serial(async () => {
      const s = this.currentSession || this.selectSession();
      if (this.nativeHandoff.has(s.id))
        throw new Error("请先关闭该会话的原生终端。");
      const release = this.sessionStore.acquire(s.cliConversationId || s.id);
      try {
        await this.nativeHandoff.importHistory(s);
        this.sessionStore.saveSession(s);
        await this.sessionStore.flush();
        this.sendSnapshot();
      } finally {
        release();
      }
    });
  }
  async setModel(
    model: string,
    effort?: string,
  ): Promise<SessionMeta | undefined> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      const s = this.currentSession || this.selectSession();
      const r = resolveModel(model, effort || s.effort);
      await this.processManager.stop();
      this.releaseExecutionClaim();
      this.activeSignature = "";
      const prior = { model: s.model, effort: s.effort };
      s.model = r.familyModel;
      s.effort = r.effort;
      this.sessionStore.saveSession(s);
      try {
        await this.sessionStore.flush();
      } catch (error) {
        Object.assign(s, prior);
        this.sessionStore.saveSession(s);
        this.sendSnapshot();
        throw error;
      }
      this.sendSnapshot();
      return s;
    });
  }
  async setDangerouslySkipPermissions(enabled: boolean): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      await this.processManager.stop();
      this.releaseExecutionClaim();
      const s = this.currentSession || this.selectSession();
      const prior = {
        dangerouslySkipPermissions: s.dangerouslySkipPermissions,
        permissionSource: s.permissionSource,
      };
      s.dangerouslySkipPermissions = enabled;
      s.permissionSource = "session";
      this.sessionStore.saveSession(s);
      try {
        await this.sessionStore.flush();
      } catch (error) {
        Object.assign(s, prior);
        this.sessionStore.saveSession(s);
        this.sendSnapshot();
        throw error;
      }
      this.activeSignature = "";
      this.sendSnapshot();
    });
  }
  async setPlanMode(enabled: boolean): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      const s = this.currentSession || this.selectSession();
      if (!!s.planMode !== enabled) {
        await this.processManager.stop();
        this.releaseExecutionClaim();
        this.activeSignature = "";
        const prior = s.planMode;
        if (prior) s.planCliConversationId = s.cliConversationId;
        else s.normalCliConversationId = s.cliConversationId;
        const previousCli = s.cliConversationId;
        s.cliConversationId = enabled
          ? s.planCliConversationId
          : s.normalCliConversationId;
        s.cliUsageTotal = 0;
        s.planMode = enabled;
        this.sessionStore.saveSession(s);
        try {
          await this.sessionStore.flush();
        } catch (error) {
          s.planMode = prior;
          s.cliConversationId = previousCli;
          this.sessionStore.saveSession(s);
          this.sendSnapshot();
          throw error;
        }
      }
      this.sendSnapshot();
    });
  }
  async openNativeCli(): Promise<void> {
    this.requireIdle();
    return this.serial(async () => {
      this.requireIdle();
      await this.processManager.stop();
      this.releaseExecutionClaim();
      this.activeSignature = "";
      let s = this.currentSession || this.selectSession();
      const workspace = await this.requireWorkspace(s, this.epoch);
      const capability = await cliCapabilities.discover(
        this.getConfig().cliPath,
        workspace.root,
      );
      if (!capability.streamJson) {
        if (this.nativeHandoff.has(s.id))
          throw new Error("此会话已在原生 CLI 中打开。");
        // Unknown versions may have incompatible flags/transcripts. Open the launcher
        // without fabricating a resumable CLI ID or silently mapping old options.
        const release = this.sessionStore.acquireExecution(s.id, true);
        this.lastHandoffMode = "standalone";
        this.nativeHandoff.launch(
          s.id,
          release,
          capability.cliPath,
          workspace.root,
          [],
          (complete) => {
            try {
              complete();
            } catch (error) {
              this.publishRuntime();
              this.publish({
                type: "error",
                sessionId: s.id,
                message: new ExecutionClaimReleaseError(error).message,
              });
              return;
            }
            this.publishRuntime();
            this.publish({
              type: "notice",
              message: "未验证版本的独立 CLI 已关闭；没有导入未验证的记录。",
            });
          },
        );
        this.publish({
          type: "notice",
          message:
            "CLI 版本未验证，已打开独立原生终端；不会自动恢复侧栏 ID 或传入模型/模式参数，请在原生界面核对配置。",
        });
        return;
      }
      s = await this.ensureReady(s, this.epoch);
      const handoffProfile = executionProfile(
        s.model,
        {
          ...this.preparedProfile!.options,
          conversationId: s.cliConversationId,
          createProject: false,
        },
        this.preparedProfile!.capabilities,
      );
      await this.processManager.stop();
      this.releaseExecutionClaim();
      this.activeSignature = "";
      const cli = handoffProfile.options.cliPath;
      const args = buildCliArguments(handoffProfile.options, false);
      await this.nativeHandoff.checkpoint(s);
      this.sessionStore.saveSession(s);
      await this.sessionStore.flush();
      if (this.nativeHandoff.has(s.id))
        throw new Error("此会话已在原生 CLI 中打开。");
      this.releaseLock = this.sessionStore.acquireExecution(
        s.cliConversationId || s.id,
        true,
      );
      const release = this.releaseLock;
      this.releaseLock = undefined;
      this.lastHandoffMode = "resume";
      this.nativeHandoff.launch(
        s.id,
        release,
        cli,
        handoffProfile.options.cwd,
        args,
        (complete) => {
          void this.serial(async () => {
            let hasMore: boolean | undefined;
            try {
              hasMore = await this.nativeHandoff.importHistory(s);
              this.sessionStore.saveSession(s);
              await this.sessionStore.flush();
            } finally {
              complete();
            }
            if (this.currentSession?.id === s.id) this.sendSnapshot();
            this.publish({
              type: "notice",
              message: hasMore
                ? "原生终端已关闭，已同步首批文字；在原会话输入 /history sync 继续同步。"
                : "原生 CLI 终端已关闭，可从历史恢复；新增可见文字已同步。",
            });
          }).catch((error) => {
            try {
              complete();
            } catch (cleanupError) {
              error = combineOperationFailures(error, cleanupError);
            }
            if (this.currentSession?.id === s.id) this.publishRuntime();
            this.publish({
              type: "error",
              sessionId: s.id,
              message: `原生记录同步或执行锁释放失败：${failureText(error)} 原始 CLI 记录仍保留。`,
            });
          });
        },
      );
      this.publish({
        type: "error",
        message:
          "已交接到原生 CLI。为避免同一会话并行执行，侧栏将新建会话；旧会话记录仍保留。",
      });
      this.createDraft(s);
      this.sendSnapshot();
    });
  }
  publishAgents(): void {
    this.publish({
      type: "agents",
      agents: this.agentRegistry?.snapshot() || [],
    });
  }
  copyText(scope: "last" | "loaded" = "last"): string {
    if (this.turn) this.updateTranscript();
    const messages = [...(this.currentSession?.messages || [])];
    if (this.turn?.message.content && !messages.includes(this.turn.message))
      messages.push(this.turn.message);
    if (scope === "last")
      return (
        messages.filter((message) => message.role === "assistant").at(-1)
          ?.content || ""
      );
    return messages
      .map(
        (message) =>
          `${message.role === "user" ? "你" : message.role === "assistant" ? "Antigravity" : "系统"}\n${message.content}`,
      )
      .join("\n\n");
  }
  watchAgents(enabled: boolean): void {
    this.agentsWatching = enabled;
    this.agentRegistry?.watch(enabled);
  }
  async agentDetail(id: string, offset = 0): Promise<void> {
    const registry = this.agentRegistry,
      session = this.currentSession;
    if (!registry || !session) throw new Error("子代理不存在。");
    const page = await registry.detailAsync(id, offset);
    if (
      this.disposed ||
      this.agentRegistry !== registry ||
      this.currentSession !== session
    )
      throw new Error("子代理对话来源已变更。");
    this.publish({ type: "agentDetail", agentId: id, ...page });
  }
  async approvePlan(messageId: string): Promise<void> {
    this.requireIdle();
    const approval = capturePlanApproval(this.currentSession, messageId);
    await this.setPlanMode(false);
    assertPlanApproval(this.currentSession, approval);
    const { plan, parallel } = approval;
    await this.sendMessage(
      "用户已批准以下方案，请按方案实施：\n\n" + plan,
      undefined,
      parallel ? "批准并以多 Agent 执行方案" : "批准并执行方案",
      parallel,
    );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.abortTurn();
      await this.sessionStore.flush();
    } catch (error) {
      this.disposed = false;
      throw error;
    }
    this.agentRegistry?.dispose();
    this.sessionStore.off("storageError", this.storageErrorListener);
    this.sessionStore.off("toolOutputPersisted", this.toolPersistedListener);
    this.sessionStore.off("messageCommitted", this.messageCommittedListener);
    this.commitDiagnostics.clear();
    this.sessionStore.off("storagePressure", this.storagePressureListener);
    this.removeAllListeners();
  }
}
