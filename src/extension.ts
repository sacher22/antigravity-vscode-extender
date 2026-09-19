import * as vscode from "vscode";
import { AgyService } from "./services/agyService";
import { SessionStore } from "./core/sessionStore";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { DiffContentProvider } from "./services/diffProvider";
import { registerCommands } from "./commands/index";

export function activate(context: vscode.ExtensionContext) {
  const sessionStore = new SessionStore(context);
  const agyService = new AgyService(context, sessionStore);
  const diffProvider = new DiffContentProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DiffContentProvider.scheme,
      diffProvider
    )
  );

  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    agyService,
    sessionStore,
    diffProvider
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  registerCommands(context, chatViewProvider, agyService);

  context.subscriptions.push({
    dispose: () => {
      agyService.dispose();
    },
  });
}

export function deactivate() {}
