import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { AgyProcessManager } from "../core/agyProcessManager";
import { BinaryResolver } from "../core/binaryResolver";
import { SessionStore } from "../core/sessionStore";
import { AntigravityConfig, SessionMeta, ChatMessage, StepUpdatePayload, ResultPayload } from "../core/types";
import { EventEmitter } from "events";

export class AgyService extends EventEmitter {
  private processManager: AgyProcessManager;
  private currentSession: SessionMeta | null = null;
  private isProcessing: boolean = false;
  private dangerousPermissionOverride: boolean | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionStore: SessionStore
  ) {
    super();
    this.processManager = new AgyProcessManager();
    this.setupProcessEvents();
  }

  public getConfig(): AntigravityConfig {
    const config = vscode.workspace.getConfiguration("antigravity");
    const configuredSkip = config.get<boolean>("dangerouslySkipPermissions", true);
    return {
      cliPath: config.get<string>("cliPath", ""),
      defaultModel: config.get<string>("defaultModel", "gemini-3.8-flash-high"),
      reasoningEffort: config.get<"high" | "medium" | "low">("reasoningEffort", "high"),
      dangerouslySkipPermissions: this.dangerousPermissionOverride !== null ? this.dangerousPermissionOverride : configuredSkip,
      autoScroll: config.get<boolean>("autoScroll", true),
      includeProjectRules: config.get<boolean>("includeProjectRules", true),
    };
  }

  public setDangerouslySkipPermissions(enabled: boolean): void {
    this.dangerousPermissionOverride = enabled;
    // Also save to settings
    vscode.workspace.getConfiguration("antigravity").update(
      "dangerouslySkipPermissions",
      enabled,
      vscode.ConfigurationTarget.Global
    );
  }

  public get currentSessionMeta(): SessionMeta | null {
    return this.currentSession;
  }

  public get processing(): boolean {
    return this.isProcessing;
  }

  private setupProcessEvents(): void {
    this.processManager.on("step_update", (step: StepUpdatePayload) => {
      this.emit("step_update", step);
    });

    this.processManager.on("result", (result: ResultPayload) => {
      this.isProcessing = false;
      this.emit("result", result);
    });

    this.processManager.on("error", (err: Error) => {
      this.isProcessing = false;
      this.emit("error", err);
    });

    this.processManager.on("exit", (info) => {
      this.isProcessing = false;
      this.emit("exit", info);
    });
  }

  public async startOrSwitchSession(conversationId?: string): Promise<SessionMeta> {
    const config = this.getConfig();
    const cliPath = await BinaryResolver.resolveCliPath(config.cliPath);
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();

    // If already active with the same session id, return it
    if (conversationId && this.currentSession && this.currentSession.id === conversationId && this.processManager.active) {
      return this.currentSession;
    }

    // Kill existing process if switching sessions
    this.processManager.kill();

    let targetSession: SessionMeta | undefined;
    if (conversationId) {
      targetSession = this.sessionStore.getSession(conversationId);
    }

    if (!targetSession) {
      // Create a temporary session entry
      const tempId = conversationId || "sess_" + Date.now();
      targetSession = this.sessionStore.createSession(
        tempId,
        config.defaultModel,
        config.reasoningEffort
      );
    }

    const assignedId = await this.processManager.start({
      cliPath,
      cwd,
      model: targetSession.model || config.defaultModel,
      effort: targetSession.effort || config.reasoningEffort,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      conversationId: targetSession.id.startsWith("sess_") ? undefined : targetSession.id,
    });

    if (assignedId && assignedId !== targetSession.id) {
      this.sessionStore.deleteSession(targetSession.id);
      targetSession.id = assignedId;
      this.sessionStore.saveSession(targetSession);
    }

    this.currentSession = targetSession;
    this.sessionStore.setCurrentSessionId(targetSession.id);
    this.emit("session_activated", targetSession);
    return targetSession;
  }

  public async sendMessage(prompt: string): Promise<void> {
    if (this.isProcessing) {
      throw new Error("Antigravity is currently responding to a previous prompt. Please wait or stop.");
    }

    if (!this.processManager.active || !this.currentSession) {
      await this.startOrSwitchSession(this.currentSession?.id);
    }

    // Check project rules if this is first message in session
    let enhancedPrompt = prompt;
    if (this.currentSession && (!this.currentSession.messages || this.currentSession.messages.length === 0)) {
      const projectRules = this.readProjectRules();
      if (projectRules) {
        enhancedPrompt = `[Project Guidelines & Context]\n${projectRules}\n\n[User Instruction]\n${prompt}`;
      }
    }

    this.isProcessing = true;
    this.processManager.sendMessage(enhancedPrompt);
  }

  private readProjectRules(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const root = folders[0].uri.fsPath;

    const ruleCandidates = [
      path.join(root, ".antigravityrules"),
      path.join(root, "AGENTS.md"),
      path.join(root, ".github", "copilot-instructions.md")
    ];

    for (const candidate of ruleCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          const content = fs.readFileSync(candidate, "utf-8").trim();
          if (content) return content;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  public abortTurn(): void {
    if (this.isProcessing) {
      this.processManager.abortCurrentTurn();
      this.isProcessing = false;
      this.emit("aborted");
    }
  }

  public async setModel(model: string, effort?: string): Promise<void> {
    if (this.currentSession) {
      this.currentSession.model = model;
      if (effort) {
        this.currentSession.effort = effort;
      }
      this.sessionStore.saveSession(this.currentSession);

      if (this.processManager.active) {
        await this.startOrSwitchSession(this.currentSession.id);
      }
    }
  }

  public dispose(): void {
    this.processManager.kill();
  }
}
