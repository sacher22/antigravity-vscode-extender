import {combineOperationFailures} from "../core/operationFailures";
import type {RequestMeasurement} from "../core/requestTelemetry";
import type { RenderMeasurement, RenderProbeKind } from "../core/renderTelemetry";
import { EventEmitter } from "events";
import { ConversationController } from "./controller";
import { ConversationRepository } from "./repository";
import { DiagnosticJournal } from "./diagnosticJournal";
import type { WorkspacePort } from "../adapters/workspaceAdapter";
import type { SessionMeta, WebviewMessage } from "../core/types";

/** Each conversation owns its executor; changing the selected view never stops it. */
export class ConversationCoordinator extends EventEmitter {
  private readonly diagnosticJournal = new DiagnosticJournal();
  diagnosticsSnapshot() {
    return {...this.diagnosticJournal.snapshot(), processes: Array.from(this.runners).slice(0, 64).map(runner => runner.diagnosticProcessSnapshot()),
      omittedProcesses: Math.max(0, this.runners.size - 64)};
  }
  clearDiagnostics() {this.diagnosticJournal.clear();}
  recordRequest(measurement: RequestMeasurement) {this.diagnosticJournal.recordRequest(measurement);}
  recordRender(measurement: RenderMeasurement) {this.diagnosticJournal.recordRender(measurement);}
  markRenderPost(turnId: string, kind: RenderProbeKind) {this.selected?.markRenderPost(turnId, kind);}
  private runners = new Set<ConversationController>();
  private selected?: ConversationController;
  private sequence = 0;
  private lastList?: Extract<WebviewMessage, {type: "sessionList"}>;
  private listTimer?: NodeJS.Timeout;
  private creating?: Promise<void>;
  private retiring = new Set<ConversationController>();
  private disposed = false;
  private disposing?: Promise<void>;
  private selectionQueue: Promise<void> = Promise.resolve();
  private selectionRevision = 0;
  private selectTransaction(work: () => Promise<void>): Promise<void> {
    const result = this.selectionQueue.then(work);
    this.selectionQueue = result.catch(() => undefined);
    return result;
  }
  private readonly storageErrorListener = () =>
    this.deliver({
      type: "error",
      message: "会话记录保存失败，请检查磁盘空间与目录权限。",
    });
  private readonly cleanupWarningListener = (message: string) => this.deliver({type: "notice", message});
  private readonly nativeExecutionListener = (id: string) => {
    const session = this.selected?.currentSessionMeta;
    if (session && (session.cliConversationId || session.id) === id) this.selected?.sendSnapshot();
    this.scheduleList();
  };
  constructor(
    private readonly environment: WorkspacePort,
    private readonly repository: ConversationRepository,
    private readonly factory = () =>
      new ConversationController(environment, repository, undefined, false, this.diagnosticJournal),
  ) {
    super();
    repository.on("storageError", this.storageErrorListener);
    repository.on("cleanupWarning", this.cleanupWarningListener);
    repository.on("nativeExecutionChanged", this.nativeExecutionListener);
  }
  private deliver(message: WebviewMessage) {
    this.emit("message", { ...message, sequence: ++this.sequence });
  }
  private attach(): ConversationController {
    const runner = this.factory();
    this.runners.add(runner);
    runner.on("message", (m: WebviewMessage) => {
      if (runner === this.selected && m.type !== "sessionList") this.deliver(m);
      // Background text stays in its execution transcript. Only changed lifecycle is sent.
      if (["turnState", "initSession", "notice", "error"].includes(m.type))
        this.scheduleList();
    });
    return runner;
  }
  private current(): ConversationController {
    if (!this.selected) {
      this.selected = this.attach();
      this.selected.prepareOrSwitchSessionUI();
    }
    return this.selected;
  }
  private scheduleList() {
    if (!this.listTimer && !this.disposed)
      this.listTimer = setTimeout(() => {
        this.listTimer = undefined;
        this.publishList();
        this.evictIdle();
      }, 30);
  }
  private evictIdle() {
    void this.repository.trimTranscriptCache(id =>
      id !== this.selected?.currentSessionMeta?.id &&
      !Array.from(this.runners).some(runner => runner.currentSessionMeta?.id === id && !runner.canCompactTranscript),
    ).catch(error => this.environment.log("Transcript cache trim failed: " + String(error)));
    const idle = Array.from(this.runners).filter(
      (r) => r !== this.selected && !this.retiring.has(r) && r.canEvict,
    );
    for (const runner of idle.slice(0, Math.max(0, idle.length - 2))) {
      this.retiring.add(runner);
      void runner
        .dispose()
        .then(() => this.runners.delete(runner))
        .catch((e) =>
          this.environment.log("Idle CLI release failed: " + String(e)),
        ).finally(() => this.retiring.delete(runner));
    }
  }
  private publishList(force = false) {
    if (this.disposed) return;
    const currentId = this.currentSessionMeta?.id || "";
    const states = new Map(
      Array.from(this.runners, (r) => [
        r.currentSessionMeta?.id,
        r.terminationPending ? {phase: "exit_unconfirmed"} : r.activeTurnState,
      ]),
    );
    const all = this.repository.getAllSessions();
    const important = new Set([currentId]);
    for (const [id, state] of states) {
      if (id && state && !["completed", "aborted", "failed", "idle"].includes(state.phase)) important.add(id);
    }
    // Retain background execution/refusal notices even outside recent history.
    // Full metadata remains in the Host's native searchable picker.
    const recentIds = new Set(all.slice(0, 200).map(session => session.id));
    const publicSessions = all.filter(session => recentIds.has(session.id) || important.has(session.id) ||
      (session.messages.at(-1)?.status || session.lastMessageStatus) === "permission_denied");
    const list: Extract<WebviewMessage, {type: "sessionList"}> = {
      type: "sessionList",
      currentId,
      totalCount: all.length,
      sessions: publicSessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        phase:
          states.get(s.id)?.phase ||
          s.messages.at(-1)?.status ||
          s.lastMessageStatus,
      })),
    };
    const previous = this.lastList;
    if (!force && previous?.currentId === list.currentId && previous.totalCount === list.totalCount && previous.sessions.length === list.sessions.length &&
      list.sessions.every((session, i) => {
        const before = previous.sessions[i];
        // Checkpoint timestamps alone have no visible effect when ordering is unchanged.
        return before.id === session.id && before.title === session.title && before.phase === session.phase;
      })) return;
    this.lastList = list;
    this.deliver(list);
  }
  /** Capture before awaits so compound commands cannot retarget a later selection. */
  executionTarget() {
    return this.current();
  }
  get processing() {
    return this.current().processing;
  }
  get currentSessionMeta() {
    return this.selected?.currentSessionMeta || null;
  }
  getConfig() {
    return this.environment.config();
  }
  recordDiagnostic(message: string) {
    this.current().recordDiagnostic(message);
  }
  prepareOrSwitchSessionUI(id?: string): SessionMeta {
    if (!id) return this.current().prepareOrSwitchSessionUI();
    let runner = Array.from(this.runners).find(
      (r) => r.currentSessionMeta?.id === id || r.ownsNativeSession(id),
    );
    if (!runner) {
      runner = this.attach();
      try {
        runner.prepareOrSwitchSessionUI(id);
      } catch (error) {
        this.runners.delete(runner);
        void runner.dispose().catch(() => undefined);
        throw error;
      }
    }
    runner.prepareOrSwitchSessionUI(id);
    this.selectionRevision++;
    if (this.selected !== runner) this.selected?.watchAgents(false);
    this.selected = runner;
    this.repository.setCurrentSessionId(id);
    return runner.currentSessionMeta!;
  }
  restoreSelection() {
    return this.selectTransaction(async () => {
      const id =
        this.currentSessionMeta?.id || this.repository.getCurrentSessionId();
      if (id) await this.repository.getSessionAsync(id);
      this.prepareOrSwitchSessionUI(id);
    });
  }
  sendSnapshot() {
    this.current().sendSnapshot();
    this.publishList(true);
  }
  newSession(force = false): Promise<void> {
    if (this.creating) return this.creating;
    this.creating = this.selectTransaction(async () => {
      const revision = this.selectionRevision;
      const previous = this.current();
      if (
        !force &&
        !previous.processing &&
        !previous.hasNativeHandoff &&
        !previous.terminationPending &&
        !previous.executionClaimPending &&
        this.repository.isEmptySession(previous.currentSessionMeta || undefined)
      ) {
        await previous.setPlanMode(false);
        previous.sendSnapshot();
        return;
      }
      const model = previous.currentSessionMeta?.model;
      const effort = previous.currentSessionMeta?.effort;
      const permissions = previous.getConfig().dangerouslySkipPermissions;
      const next = this.attach();
      try {
        await next.newSession(true);
        if (model) await next.setModel(model, effort);
        if (next.getConfig().dangerouslySkipPermissions !== permissions)
          await next.setDangerouslySkipPermissions(permissions);
      } catch (error) {
        this.runners.delete(next);
        await next.dispose().catch(() => undefined);
        if (previous.currentSessionMeta)
          this.repository.setCurrentSessionId(previous.currentSessionMeta.id);
        throw error;
      }
      if (revision !== this.selectionRevision) {
        if (this.currentSessionMeta)
          this.repository.setCurrentSessionId(this.currentSessionMeta.id);
        this.sendSnapshot();
        return;
      }
      this.selectionRevision++;
      this.selected?.watchAgents(false);
      this.selected = next;
      this.sendSnapshot();
    }).finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }
  switchSession(id: string) {
    return this.selectTransaction(async () => {
      await this.repository.getSessionAsync(id);
      this.prepareOrSwitchSessionUI(id);
      this.sendSnapshot();
    });
  }
  isSessionRunning(id: string) {
    return Array.from(this.runners).some(
      (r) => r.currentSessionMeta?.id === id && r.processing,
    );
  }
  deleteSession(id: string, confirmed = false) {
    return this.selectTransaction(() =>
      this.deleteSelectedSession(id, confirmed),
    );
  }
  private async deleteSelectedSession(id: string, confirmed: boolean) {
    const runner = Array.from(this.runners).find(
      (r) => r.currentSessionMeta?.id === id,
    );
    if (runner?.processing && !confirmed)
      throw new Error("运行中的会话需要确认停止后才能删除。");
    if (runner) {
      const watching = runner.isWatchingAgents;
      runner.watchAgents(false);
      try {
        await runner.abortTurn();
        await this.repository.deleteSession(id);
      } catch (error) {
        runner.watchAgents(watching);
        if (runner === this.selected) runner.sendSnapshot();
        throw error;
      }
      await runner.dispose();
      this.runners.delete(runner);
    } else {
      await this.repository.deleteSession(id);
    }
    if (runner === this.selected || this.currentSessionMeta?.id === id) {
      this.selected = undefined;
      const id = this.repository.getAllSessions()[0]?.id;
      this.prepareOrSwitchSessionUI(id);
    }
    this.sendSnapshot();
  }
  sendMessage(
    text: string,
    requestId?: string,
    displayText = text,
    parallel?: boolean,
    verifiedSkill = false,
  ) {
    return this.current().sendMessage(
      text,
      requestId,
      displayText,
      parallel,
      verifiedSkill,
    );
  }
  abortTurn() {
    return this.current().abortTurn();
  }
  setExecutionOptions(
    options: Pick<
      SessionMeta,
      "customAgent" | "sandbox" | "schemaPath" | "extraDirectories"
    >,
  ) {
    return this.current().setExecutionOptions(options);
  }
  syncNativeHistory() {
    return this.current().syncNativeHistory();
  }
  setModel(model: string, effort?: string) {
    return this.current().setModel(model, effort);
  }
  setPlanMode(enabled: boolean) {
    return this.current().setPlanMode(enabled);
  }
  approvePlan(messageId: string) {
    return this.current().approvePlan(messageId);
  }
  setDangerouslySkipPermissions(enabled: boolean) {
    return this.current().setDangerouslySkipPermissions(enabled);
  }
  saveDraft(text: string, attachment?: SessionMeta["attachment"]) {
    return this.current().saveDraft(text, attachment);
  }
  loadHistory(before: number) {
    return this.current().loadHistory(before);
  }
  toolDetail(messageId: string | undefined, index: number, offset = 0) {
    return this.current().toolDetail(messageId, index, offset);
  }
  agents() {
    return this.current().publishAgents();
  }
  agentDetail(id: string, offset = 0) {
    return this.current().agentDetail(id, offset);
  }
  watchAgents(enabled: boolean) {
    return this.current().watchAgents(enabled);
  }
  async openNativeCli() {
    const runner = this.current();
    await runner.openNativeCli();
    this.repository.setCurrentSessionId(
      this.selected?.currentSessionMeta?.id || runner.currentSessionMeta!.id,
    );
    this.sendSnapshot();
    return runner.currentSessionMeta!.id;
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    const work = Promise.resolve().then(() => this.disposeOwnedExecutors());
    this.disposing = work;
    void work.finally(() => {
      if (this.disposing === work) this.disposing = undefined;
    }).catch(() => undefined);
    return work;
  }
  private async disposeOwnedExecutors(): Promise<void> {
    this.repository.off("nativeExecutionChanged", this.nativeExecutionListener);
    this.repository.off("cleanupWarning", this.cleanupWarningListener);
    this.disposed = true;
    this.repository.off("storageError", this.storageErrorListener);
    clearTimeout(this.listTimer);
    const runners = Array.from(this.runners);
    const results = await Promise.allSettled(runners.map(runner => runner.dispose()));
    let failure: unknown;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") this.runners.delete(runners[index]);
      else failure = combineOperationFailures(failure, result.reason);
    });
    try {await this.repository.flush();}
    catch (error) {failure = combineOperationFailures(failure, error);}
    // Failed executors keep their cleanup callbacks/claims for an explicit retry.
    if (failure !== undefined) throw failure;
    this.selected = undefined;
    this.removeAllListeners();
  }
}
