import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { AgyProcessManager } from "../core/agyProcessManager";
import { BinaryResolver } from "../core/binaryResolver";
import { SessionStore } from "../core/sessionStore";
import {
  AntigravityConfig,
  ResultPayload,
  SessionMeta,
  StepUpdatePayload,
  PendingInputKind,
  TurnPhase,
  TurnState,
} from "../core/types";

const WAITING_NOTICE_MS = 30_000;
const MODEL_EFFORTS: Record<string, Array<"low" | "medium" | "high">> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["medium", "high"],
  "gemini-3.1-pro": ["high"],
};

export class AgyService extends EventEmitter {
  private readonly processManager: AgyProcessManager;
  private readonly output: vscode.OutputChannel;
  private currentSession: SessionMeta | null = null;
  private isProcessing = false;
  private dangerousPermissionOverride: boolean | null = null;
  private planMode = false;
  private activeTurnId: string | null = null;
  private turnStartedAt = 0;
  private turnSequence = 0;
  private waitingTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<SessionMeta> | null = null;
  private startTargetId: string | null = null;
  private activeConfigSignature = "";
  private activeProcessSessionId: string | null = null;
  private pendingInputKind: PendingInputKind | null = null;
  private currentAgentText = "";
  private firstResponseLogged = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionStore: SessionStore
  ) {
    super();
    this.output = vscode.window.createOutputChannel("Antigravity Extender", { log: true });
    this.context.subscriptions.push(this.output);
    this.processManager = new AgyProcessManager((message) => this.log(message));
    this.setupProcessEvents();
  }

  public getConfig(): AntigravityConfig {
    const config = vscode.workspace.getConfiguration("antigravity");
    const configuredSkip = config.get<boolean>("dangerouslySkipPermissions", true);
    return {
      cliPath: config.get<string>("cliPath", ""),
      defaultModel: config.get<string>("defaultModel", "gemini-3.8-flash-high"),
      reasoningEffort: config.get<"high" | "medium" | "low">("reasoningEffort", "high"),
      dangerouslySkipPermissions: this.dangerousPermissionOverride ?? configuredSkip,
      autoScroll: config.get<boolean>("autoScroll", true),
      includeProjectRules: config.get<boolean>("includeProjectRules", true),
    };
  }

  public get currentSessionMeta(): SessionMeta | null {
    return this.currentSession;
  }

  public get processing(): boolean {
    return this.isProcessing;
  }

  public recordDiagnostic(message: string): void {
    this.log(message);
  }

  public prepareOrSwitchSessionUI(conversationId?: string): SessionMeta {
    const config = this.getConfig();
    let targetSession: SessionMeta | undefined;

    if (conversationId) {
      targetSession = this.sessionStore.getSession(conversationId);
      if (!targetSession) {
        targetSession = this.sessionStore.createSession(
          conversationId,
          config.defaultModel,
          config.reasoningEffort
        );
      }
    } else {
      const selectedId = this.sessionStore.getCurrentSessionId();
      targetSession = this.currentSession || (selectedId ? this.sessionStore.getSession(selectedId) : undefined);
      targetSession ||= this.sessionStore.findEmptySession();
      if (!targetSession) targetSession = this.createDraftSession(config);
    }

    const resolved = this.resolveModel(
      targetSession.model || config.defaultModel,
      targetSession.effort || config.reasoningEffort
    );
    targetSession.model = resolved.familyModel;
    targetSession.effort = resolved.effort;
    if (this.currentSession?.id !== targetSession.id) {
      this.pendingInputKind = null;
      this.currentAgentText = "";
    }
    this.currentSession = targetSession;
    this.sessionStore.setCurrentSessionId(targetSession.id);
    if (this.sessionStore.isEmptySession(targetSession)) {
      this.sessionStore.removeEmptySessionsExcept(targetSession.id);
    } else {
      this.sessionStore.removeEmptySessionsExcept();
    }
    this.releaseMismatchedProcess();
    return targetSession;
  }

  public prepareNewSessionUI(): SessionMeta {
    if (this.isProcessing) {
      throw new Error("Stop the active turn before creating a new session.");
    }
    const config = this.getConfig();
    const selectedId = this.sessionStore.getCurrentSessionId();
    const current = this.currentSession || (selectedId ? this.sessionStore.getSession(selectedId) : undefined);
    if (this.sessionStore.isEmptySession(current)) {
      this.sessionStore.removeEmptySessionsExcept(current.id);
      this.currentSession = current;
      this.sessionStore.setCurrentSessionId(current.id);
      this.releaseMismatchedProcess();
      return current;
    }

    this.sessionStore.removeEmptySessionsExcept();
    const draft = this.createDraftSession(config);
    this.pendingInputKind = null;
    this.currentAgentText = "";
    this.currentSession = draft;
    this.releaseMismatchedProcess();
    return draft;
  }

  public async ensureProcessReady(conversationId?: string, forceRestart = false): Promise<SessionMeta> {
    if (this.isProcessing) {
      throw new Error("Stop the active turn before changing sessions or runtime settings.");
    }
    const targetId = conversationId || this.currentSession?.id;
    if (!targetId) {
      return this.prepareOrSwitchSessionUI();
    }
    if (this.startPromise) {
      const inFlightTarget = this.startTargetId;
      try {
        await this.startPromise;
      } catch {
        // The requested target below still gets its own start attempt.
      }
      if (inFlightTarget === targetId && this.activeProcessSessionId === targetId && this.processManager.active) {
        return this.sessionStore.getSession(targetId) || this.currentSession!;
      }
    }
    this.startTargetId = targetId;
    this.startPromise = this.doStartOrSwitchSession(targetId, forceRestart);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
      this.startTargetId = null;
    }
  }

  public async startOrSwitchSession(conversationId?: string, forceRestart = false): Promise<SessionMeta> {
    this.prepareOrSwitchSessionUI(conversationId);
    return this.ensureProcessReady(this.currentSession?.id, forceRestart);
  }

  public async sendMessage(prompt: string): Promise<string> {
    if (this.isProcessing) {
      throw new Error("Antigravity is currently responding. Stop the current turn before sending another message.");
    }

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // A UI session switch may intentionally cancel an older warmup.
      }
    }
    if (!this.processManager.active || !this.currentSession || this.activeProcessSessionId !== this.currentSession.id) {
      await this.ensureProcessReady(this.currentSession?.id, true);
    }

    const pendingInputKind = this.pendingInputKind;
    this.pendingInputKind = null;
    this.currentAgentText = "";
    this.firstResponseLogged = false;
    const turnId = `turn_${Date.now()}_${++this.turnSequence}`;
    this.activeTurnId = turnId;
    this.turnStartedAt = Date.now();
    this.isProcessing = true;
    this.emitTurnState("submitted");

    const primaryRoot = this.getWorkspaceDirectories()[0] || process.cwd();
    let userPrompt = prompt;
    if (pendingInputKind === "confirmation" && !this.isAffirmative(prompt)) {
      userPrompt = `Do not execute the previously proposed plan. Treat the following as a new request or requested plan revision:\n${prompt}`;
    }

    const promptSections = [
      `[VS Code Workspace]\nPrimary root: ${primaryRoot}\nCreate and modify all user-requested deliverables inside this workspace unless the user explicitly names another location. Do not place deliverables in Antigravity scratch or brain directories; those locations are only for internal planning metadata.`,
    ];
    if (this.planMode && pendingInputKind === null) {
      promptSections.push(
        "[Plan Mode]\nIf requirements contain material ambiguity, ask concise clarifying questions and wait for answers before finalizing the plan. After clarification, produce the plan and wait for explicit approval before editing project files."
      );
    }
    if (this.getConfig().includeProjectRules && this.currentSession && this.currentSession.messages.length <= 1) {
      const projectRules = this.readProjectRules();
      if (projectRules) {
        promptSections.push(`[Project Guidelines & Context]\n${projectRules}`);
        this.log(`project rules injected bytes=${Buffer.byteLength(projectRules)}`);
      }
    }
    promptSections.push(`[User Instruction]\n${userPrompt}`);
    const enhancedPrompt = promptSections.join("\n\n");

    try {
      await this.processManager.sendMessage(enhancedPrompt);
      this.log(`turn submitted turn=${turnId}`);
      this.scheduleWaitingNotice();
      return turnId;
    } catch (error) {
      this.pendingInputKind = pendingInputKind;
      this.finishTurn("failed");
      throw error;
    }
  }

  public async abortTurn(): Promise<void> {
    if (!this.isProcessing || !this.activeTurnId) return;
    this.emitTurnState("stopping");
    await this.processManager.abortCurrentTurn();
    this.activeConfigSignature = "";
    this.finishTurn("aborted");
    this.emit("aborted");
  }

  public async setModel(model: string, effort?: string): Promise<SessionMeta | undefined> {
    if (!this.currentSession) return undefined;
    const resolved = this.resolveModel(model, effort || this.currentSession.effort);
    this.currentSession.model = resolved.familyModel;
    this.currentSession.effort = resolved.effort;
    this.sessionStore.saveSession(this.currentSession);
    await this.startOrSwitchSession(this.currentSession.id, true);
    return this.currentSession;
  }

  public async setDangerouslySkipPermissions(enabled: boolean): Promise<void> {
    this.dangerousPermissionOverride = enabled;
    await vscode.workspace.getConfiguration("antigravity").update(
      "dangerouslySkipPermissions",
      enabled,
      vscode.ConfigurationTarget.Global
    );
    if (this.currentSession) await this.startOrSwitchSession(this.currentSession.id, true);
  }

  public async setPlanMode(enabled: boolean): Promise<void> {
    if (this.planMode === enabled) return;
    this.planMode = enabled;
    if (this.currentSession) await this.startOrSwitchSession(this.currentSession.id, true);
  }

  public dispose(): void {
    this.clearWaitingTimer();
    this.processManager.dispose();
  }

  private setupProcessEvents(): void {
    this.processManager.on("step_update", (step: StepUpdatePayload) => {
      if (!this.isProcessing || !this.activeTurnId) return;
      if (step.step_type === "agent_response" && step.text_delta && !this.firstResponseLogged) {
        this.firstResponseLogged = true;
        this.log(`turn first response turn=${this.activeTurnId} elapsedMs=${Date.now() - this.turnStartedAt}`);
      } else if (step.step_type !== "agent_response" || step.state !== "ACTIVE") {
        this.log(`turn event turn=${this.activeTurnId} type=${step.step_type} state=${step.state} elapsedMs=${Date.now() - this.turnStartedAt}`);
      }
      this.scheduleWaitingNotice();
      if (step.step_type === "agent_response" && step.text_delta) {
        this.currentAgentText += step.text_delta;
      }
      if (step.step_type === "system_message" && step.state === "DONE") {
        const turnId = this.activeTurnId;
        const inputKind = this.classifyPendingInput(this.currentAgentText);
        this.pendingInputKind = inputKind;
        this.log(`turn awaiting input turn=${turnId} elapsedMs=${Date.now() - this.turnStartedAt}`);
        this.finishTurn("awaiting_input");
        this.emit("awaiting_input", turnId, inputKind);
        return;
      }
      if (step.step_type === "agent_response") this.emitTurnState("responding");
      if (step.step_type === "tool") this.emitTurnState("tool", step.tool_name);
      this.emit("step_update", step, this.activeTurnId);
    });

    this.processManager.on("result", (result: ResultPayload) => {
      if (!this.isProcessing || !this.activeTurnId) {
        this.log("duplicate or late result ignored");
        return;
      }
      const turnId = this.activeTurnId;
      this.pendingInputKind = null;
      this.log(`turn result turn=${turnId} status=${result.status} elapsedMs=${Date.now() - this.turnStartedAt}`);
      this.finishTurn(result.status === "SUCCESS" ? "completed" : "failed");
      this.emit("result", result, turnId);
    });

    this.processManager.on("agy_error", (error: { message?: string }) => {
      this.handleTurnError(new Error(error.message || "Antigravity CLI reported an error"));
    });

    this.processManager.on("error", (error: Error) => this.handleTurnError(error));
    this.processManager.on("exit", (info) => {
      this.activeConfigSignature = "";
      this.activeProcessSessionId = null;
      if (this.isProcessing) {
        this.handleTurnError(new Error(`Antigravity process exited unexpectedly (${info.code ?? info.signal ?? "unknown"})`));
      }
      this.emit("exit", info);
    });
    this.processManager.on("stderr", (line: string) => this.log(`cli stderr: ${line}`));
    this.processManager.on("raw_output", (line: string) => this.log(`cli non-json output bytes=${Buffer.byteLength(line)}`));
  }

  private async doStartOrSwitchSession(conversationId?: string, forceRestart = false): Promise<SessionMeta> {
    const config = this.getConfig();
    const cliPath = await BinaryResolver.resolveCliPath(config.cliPath);
    const workspaceDirectories = this.getWorkspaceDirectories();
    const cwd = workspaceDirectories[0] || process.cwd();
    let targetSession = conversationId ? this.sessionStore.getSession(conversationId) : undefined;

    if (!targetSession) {
      targetSession = this.sessionStore.createSession(
        conversationId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        config.defaultModel,
        config.reasoningEffort
      );
    }

    const resolved = this.resolveModel(targetSession.model || config.defaultModel, targetSession.effort || config.reasoningEffort);
    targetSession.model = resolved.familyModel;
    targetSession.effort = resolved.effort;
    const signature = JSON.stringify({
      session: targetSession.id,
      model: resolved.effectiveModel,
      danger: config.dangerouslySkipPermissions,
      plan: this.planMode,
      cwd,
      workspaceDirectories,
    });

    if (!forceRestart && this.processManager.active && this.activeProcessSessionId === targetSession.id && signature === this.activeConfigSignature) {
      return targetSession;
    }

    this.log(`session starting id=${targetSession.id} model=${resolved.effectiveModel} effort=${resolved.effort} plan=${this.planMode}`);
    const assignedId = await this.processManager.start({
      cliPath,
      cwd,
      model: resolved.effectiveModel,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      isPlanMode: this.planMode,
      createProject: targetSession.id.startsWith("sess_"),
      additionalDirectories: workspaceDirectories,
      conversationId: targetSession.id.startsWith("sess_") ? undefined : targetSession.id,
    });

    if (assignedId && assignedId !== targetSession.id) {
      const oldId = targetSession.id;
      this.sessionStore.replaceSessionId(oldId, assignedId);
      targetSession.id = assignedId;
      if (this.currentSession?.id === oldId) this.currentSession = targetSession;
      this.emit("session_id_migrated", oldId, assignedId);
    }
    this.sessionStore.saveSession(targetSession);
    this.activeProcessSessionId = targetSession.id;
    this.activeConfigSignature = JSON.stringify({
      session: targetSession.id,
      model: resolved.effectiveModel,
      danger: config.dangerouslySkipPermissions,
      plan: this.planMode,
      cwd,
      workspaceDirectories,
    });
    if (this.currentSession?.id === targetSession.id) {
      this.currentSession = targetSession;
      this.sessionStore.setCurrentSessionId(targetSession.id);
    }
    this.emit("session_activated", targetSession);
    return targetSession;
  }

  private createDraftSession(config: AntigravityConfig): SessionMeta {
    return this.sessionStore.createSession(
      `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      config.defaultModel,
      config.reasoningEffort
    );
  }

  private releaseMismatchedProcess(): void {
    if (!this.processManager.active || this.activeProcessSessionId === this.currentSession?.id) return;
    this.activeProcessSessionId = null;
    this.activeConfigSignature = "";
    void this.processManager.stop("SIGTERM", 500);
  }

  private resolveModel(model: string, requestedEffort: string): {
    familyModel: string;
    effectiveModel: string;
    effort: "low" | "medium" | "high";
  } {
    const match = model.match(/^(.*)-(low|medium|high)$/);
    const family = match?.[1] || model;
    const currentEffort = (match?.[2] || "high") as "low" | "medium" | "high";
    const supported = MODEL_EFFORTS[family];
    const requested = requestedEffort as "low" | "medium" | "high";
    if (!supported) {
      return { familyModel: model, effectiveModel: model, effort: requested };
    }
    const effort = supported?.includes(requested) ? requested : supported?.includes(currentEffort) ? currentEffort : "high";
    return {
      familyModel: `${family}-high`,
      effectiveModel: supported ? `${family}-${effort}` : model,
      effort,
    };
  }

  private getWorkspaceDirectories(): string[] {
    const folders = vscode.workspace.workspaceFolders || [];
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const ordered = activeFolder
      ? [activeFolder, ...folders.filter((folder) => folder.uri.fsPath !== activeFolder.uri.fsPath)]
      : [...folders];
    if (ordered.length) return ordered.map((folder) => folder.uri.fsPath);
    if (activeUri?.scheme === "file") return [path.dirname(activeUri.fsPath)];
    return [process.cwd()];
  }

  private classifyPendingInput(text: string): PendingInputKind {
    const normalized = text.trim();
    const asksForChoice = /(?:with or without|which (?:option|approach)|choose|provide (?:the|a)|请选择|哪(?:个|一种)|是否需要|请(?:提供|选择|回答))/i.test(normalized);
    if (asksForChoice || /[?？]\s*$/.test(normalized)) return "question";
    const requestsApproval = /(?:confirm|approval|approve|proceed|go ahead|确认|批准|满意|开始(?:执行|实施|编写)|执行(?:该|这个|上述)?计划|实施(?:该|这个|上述)?方案)/i.test(normalized);
    return requestsApproval ? "confirmation" : "question";
  }

  private isAffirmative(text: string): boolean {
    return /^(?:执行|继续|确认|开始|同意|可以|好的?|没问题|yes|y|proceed|go ahead|implement)(?:[\s,，。.!！:].*)?$/i.test(text.trim());
  }

  private emitTurnState(phase: TurnPhase, detail?: string): void {
    if (!this.activeTurnId) return;
    const state: TurnState = {
      turnId: this.activeTurnId,
      phase,
      startedAt: this.turnStartedAt,
      detail,
    };
    this.emit("turn_state", state);
  }

  private scheduleWaitingNotice(): void {
    this.clearWaitingTimer();
    this.waitingTimer = setTimeout(() => {
      if (this.isProcessing) this.emitTurnState("waiting", "No new output yet");
    }, WAITING_NOTICE_MS);
  }

  private clearWaitingTimer(): void {
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private finishTurn(phase: "completed" | "failed" | "aborted" | "awaiting_input"): void {
    this.clearWaitingTimer();
    this.emitTurnState(phase);
    this.isProcessing = false;
    this.activeTurnId = null;
  }

  private handleTurnError(error: Error): void {
    const hadActiveTurn = this.isProcessing;
    if (hadActiveTurn) this.finishTurn("failed");
    this.emit("error", error);
  }

  private readProjectRules(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    const candidates = [
      path.join(root, ".antigravityrules"),
      path.join(root, "AGENTS.md"),
      path.join(root, ".github", "copilot-instructions.md"),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const content = fs.readFileSync(candidate, "utf8").trim();
          if (content) return content;
        }
      } catch (error) {
        this.log(`project rules read failed path=${candidate} error=${String(error)}`);
      }
    }
    return null;
  }

  private log(message: string): void {
    const redacted = message
      .replace(/((?:api[_-]?key|token|authorization|password)\s*[=:]\s*)[^\s&]+/gi, "$1<redacted>")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>");
    this.output.appendLine(`${new Date().toISOString()} ${redacted}`);
  }
}
