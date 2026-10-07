import * as vscode from "vscode";
import { ConversationCoordinator } from "../conversation/coordinator";
import { VSCodeWorkspaceAdapter } from "../adapters/workspaceAdapter";
import { SessionStore } from "../core/sessionStore";
/** Compatibility facade for extension commands; execution lives in the pure controller. */
export class AgyService extends ConversationCoordinator {
  constructor(context: vscode.ExtensionContext, store: SessionStore) {
    super(new VSCodeWorkspaceAdapter(context), store);
    if (vscode.workspace.onDidChangeWorkspaceFolders)
      context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          void this.newSession(true).catch((error) =>
            this.emit("message", { type: "error", message: String(error) }),
          );
        }),
      );
  }
}
