import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { AgyService } from "../services/agyService";
import { SessionStore } from "../core/sessionStore";
import { DiffContentProvider } from "../services/diffProvider";
import { SlashCommandResolver } from "../core/slashCommands";
import {
  ExtensionMessage,
  WebviewMessage,
  StepUpdatePayload,
  ResultPayload,
  SessionMeta,
  ToolCallItem,
} from "../core/types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "antigravity.chatView";
  private view?: vscode.WebviewView;
  private currentTurnTools: Map<number, ToolCallItem> = new Map();
  private currentAssistantText = "";
  private currentTurnId: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agyService: AgyService,
    private readonly sessionStore: SessionStore,
    private readonly diffProvider: DiffContentProvider
  ) {
    this.setupAgyListeners();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: ExtensionMessage) => {
      try {
        await this.handleWebviewMessage(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.postMessage({ type: "error", message });
        this.postMessage({ type: "statusChange", status: "error" });
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshSessionList();
      }
    });
  }

  private setupAgyListeners(): void {
    this.agyService.on("step_update", (step: StepUpdatePayload, turnId: string) => {
      if (!this.view) return;
      if (this.currentTurnId && turnId !== this.currentTurnId) return;

      if (step.step_type === "agent_response" && step.text_delta) {
        this.currentAssistantText += step.text_delta;
        this.postMessage({
          type: "streamDelta",
          stepIndex: step.step_index,
          delta: step.text_delta,
        });
      } else if (step.step_type === "tool" && step.tool_name) {
        let toolCall = this.currentTurnTools.get(step.step_index);
        if (!toolCall) {
          toolCall = {
            stepIndex: step.step_index,
            name: step.tool_name,
            state: step.state as "ACTIVE" | "DONE" | "FAILED",
            parameters: step.tool_info?.parameters,
            output: step.tool_info?.output,
          };
          this.currentTurnTools.set(step.step_index, toolCall);
        } else {
          toolCall.state = step.state as "ACTIVE" | "DONE" | "FAILED";
          if (step.tool_info?.parameters) {
            toolCall.parameters = step.tool_info.parameters;
          }
          if (step.tool_info?.output !== undefined) {
            toolCall.output = step.tool_info.output;
          }
        }

        this.postMessage({
          type: "toolUpdate",
          stepIndex: step.step_index,
          toolName: step.tool_name,
          state: step.state as "ACTIVE" | "DONE" | "FAILED",
          toolInfo: step.tool_info,
        });
      }
    });

    this.agyService.on("result", (result: ResultPayload, turnId: string) => {
      if (!this.view) return;
      if (this.currentTurnId && turnId !== this.currentTurnId) return;
      this.saveAssistantMessage(
        result.status === "SUCCESS" ? "completed" : "error",
        result.response,
        result.usage
      );

      this.postMessage({
        type: "turnComplete",
        result,
        usage: result.usage,
      });
      this.postMessage({ type: "statusChange", status: "idle" });
      this.refreshSessionList();
    });

    this.agyService.on("awaiting_input", (turnId: string, kind: import("../core/types").PendingInputKind) => {
      if (!this.view) return;
      if (this.currentTurnId && turnId !== this.currentTurnId) return;
      this.saveAssistantMessage("awaiting_input", "", undefined, kind);
      this.postMessage({ type: "turnAwaitingInput", kind });
      this.refreshSessionList();
    });

    this.agyService.on("turn_state", (state) => {
      if (state.phase === "submitted") this.currentTurnId = state.turnId;
      this.postMessage({ type: "turnState", state });
    });

    this.agyService.on("error", (err: Error) => {
      this.currentAssistantText = "";
      this.currentTurnTools.clear();
      this.currentTurnId = null;
      this.postMessage({ type: "error", message: err.message });
      this.postMessage({ type: "statusChange", status: "error" });
    });

    this.agyService.on("aborted", () => {
      this.currentAssistantText = "";
      this.currentTurnTools.clear();
      this.currentTurnId = null;
      this.postMessage({ type: "statusChange", status: "idle" });
    });

    this.agyService.on("session_id_migrated", (oldId: string, newId: string) => {
      this.refreshSessionList();
    });

    this.agyService.on("session_activated", () => {
      this.refreshSessionList();
    });
  }

  private async handleWebviewMessage(data: ExtensionMessage): Promise<void> {
    switch (data.command) {
      case "ready": {
        const currentId = this.sessionStore.getCurrentSessionId();
        const session = this.agyService.prepareOrSwitchSessionUI(currentId);
        this.initSessionInWebview(session);
        this.refreshSessionList();
        this.postMessage({ type: "connectionState", state: "ready" });
        this.sendSlashCommands();
        if (session.messages.length > 0) {
          void this.agyService.ensureProcessReady(session.id).catch((err) => {
            this.agyService.recordDiagnostic(`ready background warmup error: ${String(err)}`);
          });
        }
        break;
      }

      case "getSlashCommands": {
        this.sendSlashCommands();
        break;
      }

      case "sendMessage": {
        this.agyService.recordDiagnostic(`webview send received transitMs=${data.clientSentAt ? Math.max(0, Date.now() - data.clientSentAt) : "unknown"}`);
        let fullPrompt = data.text;
        if (data.contextCode) {
          fullPrompt = `Selected context code (${data.filePath || "active editor"}):\n\`\`\`\n${data.contextCode}\n\`\`\`\n\nUser request: ${data.text}`;
        }

        let session = this.agyService.currentSessionMeta;
        let userMessageSaved = false;
        if (session) {
          this.saveUserMessage(session, fullPrompt, data.text);
          userMessageSaved = true;
        }

        this.currentAssistantText = "";
        this.currentTurnTools.clear();
        this.postMessage({ type: "statusChange", status: "running" });

        try {
          this.currentTurnId = await this.agyService.sendMessage(fullPrompt);
          if (!userMessageSaved) {
            session = this.agyService.currentSessionMeta;
            if (session) this.saveUserMessage(session, fullPrompt, data.text);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.postMessage({ type: "error", message });
          this.postMessage({ type: "statusChange", status: "error" });
        }
        break;
      }

      case "reportRender": {
        this.agyService.recordDiagnostic(`webview rendered kind=${data.kind} clientTime=${data.clientRenderedAt}`);
        break;
      }

      case "openResource": {
        try {
          await this.openResource(data.href);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Antigravity: ${message}`);
        }
        break;
      }

      case "abortCurrentTurn": {
        await this.agyService.abortTurn();
        break;
      }

      case "newSession": {
        this.createNewSession();
        break;
      }

      case "switchSession": {
        this.agyService.prepareOrSwitchSessionUI(data.conversationId);
        this.refreshSessionList();
        this.initCurrentSessionInWebview();
        break;
      }

      case "deleteSession": {
        this.sessionStore.deleteSession(data.conversationId);
        const nextId = this.sessionStore.getCurrentSessionId();
        this.agyService.prepareOrSwitchSessionUI(nextId);
        this.refreshSessionList();
        this.initCurrentSessionInWebview();
        break;
      }

      case "changeModel": {
        const session = await this.agyService.setModel(data.model, data.effort);
        this.postMessage({
          type: "modelChanged",
          model: session?.model || data.model,
          effort: session?.effort || data.effort || "high",
        });
        break;
      }

      case "togglePermission": {
        await this.agyService.setDangerouslySkipPermissions(data.dangerouslySkipPermissions);
        this.postMessage({
          type: "permissionChanged",
          dangerouslySkipPermissions: data.dangerouslySkipPermissions,
        });
        vscode.window.showInformationMessage(
          `Antigravity: Mode changed to ${data.dangerouslySkipPermissions ? "Danger Mode (Auto-run tools)" : "Safe Mode (Approval required)"}`
        );
        break;
      }

      case "togglePlanMode": {
        await this.agyService.setPlanMode(data.isPlanMode);
        this.postMessage({ type: "planModeChanged", enabled: data.isPlanMode });
        break;
      }

      case "viewDiff": {
        await this.showDiffView(data.code || "", data.filePath);
        break;
      }

      case "requestContext": {
        await this.handleContextRequest(data.contextType);
        break;
      }

      case "applyCodeToEditor": {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const selection = editor.selection;
          await editor.edit((editBuilder) => {
            if (selection.isEmpty) {
              // Replace entire document if no selection
              const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
              );
              editBuilder.replace(fullRange, data.code || "");
            } else {
              editBuilder.replace(selection, data.code || "");
            }
          });
          vscode.window.showInformationMessage("Antigravity: Code applied to editor!");
        } else {
          // Open untitled document
          const doc = await vscode.workspace.openTextDocument({
            content: data.code,
            language: "typescript",
          });
          await vscode.window.showTextDocument(doc);
        }
        break;
      }

      case "copyToClipboard": {
        await vscode.env.clipboard.writeText(data.text);
        break;
      }

      case "openSettings": {
        vscode.commands.executeCommand("workbench.action.openSettings", "antigravity");
        break;
      }
    }
  }

  private async showDiffView(newCode: string, filePath?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    let originalUri: vscode.Uri | undefined = editor?.document.uri;

    if (filePath && vscode.workspace.workspaceFolders) {
      originalUri = vscode.Uri.file(path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath));
    }

    if (!originalUri) {
      vscode.window.showWarningMessage("No open file to diff against.");
      return;
    }

    const originalFileName = path.basename(originalUri.fsPath);
    const diffUri = vscode.Uri.parse(`${DiffContentProvider.scheme}:/${originalFileName}-generated.tmp`);
    this.diffProvider.setContent(diffUri, newCode);

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      diffUri,
      `${originalFileName} ↔ Antigravity Suggested Changes`
    );
  }

  public createNewSession(): void {
    this.agyService.prepareNewSessionUI();
    this.refreshSessionList();
    this.initCurrentSessionInWebview();
    this.view?.show(true);
  }

  private saveUserMessage(session: SessionMeta, content: string, titleSource: string): void {
    const messages = session.messages || [];
    messages.push({
      id: `msg_${Date.now()}`,
      role: "user",
      content,
      timestamp: Date.now(),
    });
    if (messages.length === 1 && session.title === "New Conversation") {
      session.title = titleSource.slice(0, 25) + (titleSource.length > 25 ? "..." : "");
    }
    this.sessionStore.saveSession(session);
  }

  private saveAssistantMessage(
    status: string,
    fallbackContent = "",
    usage?: import("../core/types").TokenUsage,
    pendingInputKind?: import("../core/types").PendingInputKind
  ): void {
    const session = this.agyService.currentSessionMeta;
    if (session) {
      const messages = session.messages || [];
      messages.push({
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: this.currentAssistantText || fallbackContent,
        timestamp: Date.now(),
        toolCalls: Array.from(this.currentTurnTools.values()),
        usage,
        status,
        pendingInputKind,
      });
      this.sessionStore.updateSessionMessages(session.id, messages, usage?.total_tokens);
    }
    this.currentAssistantText = "";
    this.currentTurnTools.clear();
    this.currentTurnId = null;
  }

  private async openResource(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }

    const { filePath, line } = this.resolveFileReference(href);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath || href}`);
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line !== undefined) {
      const position = new vscode.Position(Math.max(0, Math.min(line - 1, document.lineCount - 1)), 0);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(document, options);
  }

  private resolveFileReference(href: string): { filePath?: string; line?: number } {
    let value = decodeURIComponent(href.trim());
    let line: number | undefined;
    const lineMatch = value.match(/(?:#L|:)(\d+)(?::\d+)?$/i);
    if (lineMatch) {
      line = Number(lineMatch[1]);
      value = value.slice(0, lineMatch.index);
    }

    if (value.startsWith("file://")) {
      return { filePath: vscode.Uri.parse(value).fsPath, line };
    }
    if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
    if (path.isAbsolute(value)) return { filePath: path.normalize(value), line };

    const folders = vscode.workspace.workspaceFolders || [];
    const activeDirectory = vscode.window.activeTextEditor?.document.uri.scheme === "file"
      ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
      : undefined;
    const roots = [activeDirectory, ...folders.map((folder) => folder.uri.fsPath)]
      .filter((root, index, all): root is string => Boolean(root) && all.indexOf(root) === index);
    for (const root of roots) {
      const candidate = path.resolve(root, value);
      if (fs.existsSync(candidate)) return { filePath: candidate, line };
    }
    const root = roots[0];
    return { filePath: root ? path.resolve(root, value) : undefined, line };
  }

  private async handleContextRequest(type: "problems" | "git" | "file"): Promise<void> {
    if (type === "problems") {
      const allDiagnostics = vscode.languages.getDiagnostics();
      let report = "";
      let count = 0;
      for (const [uri, diags] of allDiagnostics) {
        const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
        if (errors.length > 0) {
          report += `File: ${path.basename(uri.fsPath)} (${uri.fsPath})\n`;
          for (const d of errors) {
            report += `  Line ${d.range.start.line + 1}: [${d.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning"}] ${d.message}\n`;
            count++;
          }
        }
      }
      if (count === 0) {
        vscode.window.showInformationMessage("Antigravity: No problems/errors found in workspace!");
        return;
      }
      this.sendCodeContext(report, "Workspace Problems", count, "Fix Problems in Workspace");
    } else if (type === "file") {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: "Select file to attach as context"
      });
      if (uris && uris.length > 0) {
        const doc = await vscode.workspace.openTextDocument(uris[0]);
        this.sendCodeContext(doc.getText(), path.basename(uris[0].fsPath), doc.lineCount);
      }
    }
  }

  public sendCodeContext(code: string, fileName?: string, lineCount?: number, title?: string): void {
    if (this.view) {
      this.view.show(true);
      this.postMessage({
        type: "setContext",
        code,
        file: fileName,
        lineCount,
        title,
      });
    }
  }

  private refreshSessionList(): void {
    const sessions = this.sessionStore.getAllSessions().map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    const currentId = this.sessionStore.getCurrentSessionId() || "";
    this.postMessage({
      type: "sessionList",
      sessions,
      currentId,
    });
  }

  private initCurrentSessionInWebview(): void {
    const session = this.agyService.currentSessionMeta;
    if (session) this.initSessionInWebview(session);
  }

  private initSessionInWebview(session: SessionMeta): void {
    const config = this.agyService.getConfig();
    this.postMessage({
      type: "initSession",
      session,
      config: {
        dangerouslySkipPermissions: config.dangerouslySkipPermissions,
        autoScroll: config.autoScroll,
      },
    });
  }

  private async sendSlashCommands(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const items = await SlashCommandResolver.getAvailableItems(workspaceRoot);
    this.postMessage({
      type: "slashCommands",
      commands: items,
    });
  }

  private postMessage(message: WebviewMessage): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.js")
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vendor", "marked.min.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet" />
  <script nonce="${nonce}" src="${markedUri}"></script>
  <title>Antigravity Extender</title>
</head>
<body>
  <!-- Header -->
  <div class="chat-header">
    <div class="header-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <span>ANTIGRAVITY</span>
    </div>
    <div class="header-controls">
      <!-- Plan Mode Indicator Badge -->
      <div id="plan-mode-pill" class="plan-mode-pill hidden" title="Plan Mode Active">
        <span>💡 PLAN</span>
        <span id="close-plan-mode-btn" class="close-plan-btn" title="Exit Plan Mode">✕</span>
      </div>

      <!-- Permission Toggle Mode -->
      <button id="perm-toggle-btn" class="perm-badge danger-mode" title="Toggle Danger/Safe Permission Mode">
        <span class="perm-icon">⚡</span>
        <span class="perm-text">Danger</span>
      </button>

      <select id="model-select" class="select-compact" title="Switch Model">
        <option value="gemini-3.8-flash-high">Gemini 3.8 Flash</option>
        <option value="gemini-3.7-flash-high">Gemini 3.7 Flash</option>
        <option value="gemini-3.1-pro-high">Gemini 3.1 Pro</option>
      </select>
      <select id="effort-select" class="select-compact" title="Reasoning Effort">
        <option value="high">High</option>
        <option value="medium">Med</option>
        <option value="low">Low</option>
      </select>
      <button id="new-chat-btn" class="btn-icon" title="New Session">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
    </div>
  </div>

  <!-- Session Switcher Bar & Quick Context Chips -->
  <div class="sessions-bar">
    <span style="opacity:0.7;">Chat:</span>
    <select id="session-select" class="sessions-dropdown"></select>
  </div>

  <!-- Quick Action Chips -->
  <div class="context-chips-bar">
    <button class="context-chip" id="chip-attach-file" title="Attach file to context">+ File</button>
    <button class="context-chip" id="chip-problems" title="Inspect & fix active workspace problems">+ Problems</button>
  </div>

  <!-- Messages List -->
  <div class="messages-container" id="messages">
    <!-- Messages & Tool Cards will be injected dynamically -->
  </div>

  <!-- Context Snippet preview -->
  <div id="context-preview" class="context-preview" style="display:none;">
    <span id="context-text">Attached: code selection</span>
    <span id="remove-context-btn" class="context-remove-btn" title="Remove context">✕</span>
  </div>

  <!-- Footer / Input Box -->
  <div class="input-area">
    <!-- Slash / Skills Menu -->
    <div id="slash-menu" class="slash-menu" style="display:none;"></div>
    <div class="input-box-wrapper">
      <textarea id="chat-input" class="chat-input" rows="1" placeholder="Ask Antigravity anything... (Enter to send, Shift+Enter for newline)"></textarea>
    </div>
    <div class="input-actions">
      <div class="model-status-tag" id="status-info">Ready</div>
      <div class="send-btn-group">
        <button id="stop-btn" class="btn-stop" style="display:none;">Stop</button>
        <button id="send-btn" class="btn-primary">
          <span>Send</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
