import * as vscode from "vscode";
import { ChatViewProvider } from "../ui/chatViewProvider";
import { AgyService } from "../services/agyService";

export function registerCommands(
  context: vscode.ExtensionContext,
  chatProvider: ChatViewProvider,
  agyService: AgyService
) {
  // Explain Code
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.explainCode", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection) || editor.document.getText();
      const fileName = editor.document.fileName;
      const lineCount = editor.selection.end.line - editor.selection.start.line + 1;

      chatProvider.sendCodeContext(selection, fileName, lineCount);
      agyService.sendMessage(
        `Please explain what this code does in detail, breaking down logic and architecture:\n\`\`\`\n${selection}\n\`\`\``
      );
    })
  );

  // Refactor Code
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.refactorCode", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection) || editor.document.getText();
      const fileName = editor.document.fileName;
      const lineCount = editor.selection.end.line - editor.selection.start.line + 1;

      chatProvider.sendCodeContext(selection, fileName, lineCount);
      agyService.sendMessage(
        `Please refactor the following code to improve clean architecture, readability, and performance. Provide the optimized code:\n\`\`\`\n${selection}\n\`\`\``
      );
    })
  );

  // Generate Unit Tests
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.generateTests", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection) || editor.document.getText();
      const fileName = editor.document.fileName;
      const lineCount = editor.selection.end.line - editor.selection.start.line + 1;

      chatProvider.sendCodeContext(selection, fileName, lineCount);
      agyService.sendMessage(
        `Generate comprehensive unit test coverage for the following code, including edge cases:\n\`\`\`\n${selection}\n\`\`\``
      );
    })
  );

  // Fix Problems / Debug
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.fixCode", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection) || editor.document.getText();
      const fileName = editor.document.fileName;
      const lineCount = editor.selection.end.line - editor.selection.start.line + 1;

      chatProvider.sendCodeContext(selection, fileName, lineCount);
      agyService.sendMessage(
        `Inspect the following code for bugs, race conditions, edge case failures, or performance issues, and provide fixes:\n\`\`\`\n${selection}\n\`\`\``
      );
    })
  );

  // Open Chat Sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.antigravity-sidebar");
    })
  );

  // New Session
  context.subscriptions.push(
    vscode.commands.registerCommand("antigravity.newSession", async () => {
      await agyService.startOrSwitchSession();
    })
  );
}
