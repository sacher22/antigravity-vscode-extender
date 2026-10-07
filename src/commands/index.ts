import * as vscode from "vscode";
import { ChatViewProvider } from "../ui/chatViewProvider";

export function registerCommands(
  context: vscode.ExtensionContext,
  chat: ChatViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.openChat", () =>
      vscode.commands.executeCommand(
        "workbench.view.extension.antigravity-sidebar",
      ),
    ),
    vscode.commands.registerCommand("antigravity.newSession", async () => {
      try {
        await chat.createNewSession();
      } catch (error) {
        vscode.window.showErrorMessage(String(error));
      }
    }),
  );
}
