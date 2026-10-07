import * as vscode from "vscode";
import * as path from "path";
import { AntigravityConfig, SessionMeta } from "../core/types";
export interface WorkspacePort {
  config(): AntigravityConfig;
  workspace(session?: SessionMeta): { root?: string; directories: string[] };
  setPermissions(enabled: boolean): Promise<void>;
  terminal(cli: string, cwd: string, args: string[], onClose: () => void, onProcess?: (pid: number) => void): void;
  log(message: string): void;
}
export class VSCodeWorkspaceAdapter implements WorkspacePort {
  private readonly output: vscode.OutputChannel;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Antigravity Extender", {
      log: true,
    });
    context.subscriptions.push(this.output);
  }
  config(): AntigravityConfig {
    const c = vscode.workspace.getConfiguration("antigravity");
    return {
      cliPath: c.get("cliPath", ""),
      defaultModel: c.get("defaultModel", "gemini-3.8-flash-high"),
      reasoningEffort: c.get("reasoningEffort", "high"),
      dangerouslySkipPermissions: c.get("dangerouslySkipPermissions", false),
      autoScroll: c.get("autoScroll", true),
      includeProjectRules: c.get("includeProjectRules", true),
    };
  }
  workspace(session?: SessionMeta): { root?: string; directories: string[] } {
    const roots = (vscode.workspace.workspaceFolders || []).map((f) =>
      path.resolve(f.uri.fsPath),
    );
    const saved = session?.workspaceRoot && path.resolve(session.workspaceRoot);
    const editor = vscode.window.activeTextEditor;
    const activeFolder =
      editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const active = activeFolder && path.resolve(activeFolder.uri.fsPath);
    const root =
      saved && roots.includes(saved)
        ? saved
        : active && roots.includes(active)
          ? active
          : roots[0];
    return {
      root,
      directories: root ? [root, ...roots.filter((r) => r !== root)] : [],
    };
  }
  async setPermissions(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("antigravity")
      .update(
        "dangerouslySkipPermissions",
        enabled,
        vscode.ConfigurationTarget.Global,
      );
  }
  terminal(
    cli: string,
    cwd: string,
    args: string[],
    onClose: () => void,
    onProcess?: (pid: number) => void,
  ): void {
    const terminal = vscode.window.createTerminal({
      name: "Antigravity CLI",
      cwd,
      shellPath: cli,
      shellArgs: args,
    });
    let closed = false;
    const listener = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        closed = true;
        listener.dispose();
        onClose();
      }
    });
    this.context.subscriptions.push(listener);
    terminal.show();
    if (onProcess && terminal.processId) void Promise.resolve(terminal.processId).then(pid => {
      if (!closed && pid) onProcess(pid);
    }).catch(() => this.log("Native CLI process identity unavailable; execution lease remains pending."));
  }
  log(message: string): void {
    this.output.appendLine(`${new Date().toISOString()} ${message}`);
  }
}
