import * as vscode from "vscode";
import { AgyService } from "./services/agyService";
import { SessionStore } from "./core/sessionStore";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { DiffContentProvider } from "./services/diffProvider";
import { registerCommands } from "./commands/index";

let activeService: AgyService | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const sessionStore = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Antigravity：读取会话记录" },
    progress => SessionStore.open(context, message => progress.report({message})),
  );
  const agyService = new AgyService(context, sessionStore);
  activeService = agyService;
  const diffProvider = new DiffContentProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DiffContentProvider.scheme,
      diffProvider,
    ),
  );

  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    agyService,
    sessionStore,
    diffProvider,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  context.subscriptions.push(chatViewProvider, diffProvider);
  registerCommands(context, chatViewProvider);

  context.subscriptions.push({
    dispose: () => {
      void agyService.dispose().catch(error => {
        // Subscription disposal cannot await; deactivate() still awaits the same cleanup.
        console.error("Antigravity cleanup incomplete; execution claims remain retained.", error);
      });
    },
  });
}

export async function deactivate() {
  await activeService?.dispose();
  activeService = undefined;
}
