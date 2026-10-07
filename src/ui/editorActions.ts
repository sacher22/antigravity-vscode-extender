import * as fs from "node:fs";
import * as os from "node:os";
import { resolveFileReference as resolveReference } from "../core/fileReference";
import * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "crypto";
import { SessionMeta, WebviewMessage } from "../core/types";
import { codeBlocks, actionableCodeBlocks } from "../core/codeBlocks";
import { CodePreviews, contentHash } from "./codePreviews";
import { DiffContentProvider } from "../services/diffProvider";

export class EditorActions {
  private readonly previews: CodePreviews;
  private readonly closePreview?: vscode.Disposable;
  private disposed = false;

  constructor(
    private readonly getSession: () => SessionMeta | null | undefined,
    private readonly diffProvider: DiffContentProvider,
    private readonly publish: (message: WebviewMessage) => void,
  ) {
    this.previews = new CodePreviews((preview) =>
      this.diffProvider.removeContent(preview.diffUri),
    );
    if (vscode.workspace.onDidCloseTextDocument) {
      this.closePreview = vscode.workspace.onDidCloseTextDocument((doc) => {
        this.previews.closeDocument(doc.uri.toString());
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previews.dispose();
    this.closePreview?.dispose();
  }

  public verifyCodeSource(
    messageId: string,
    blockIndex: number,
    code: string,
  ): void {
    if (this.disposed) throw new Error("编辑器操作已结束。");
    const session = this.getSession();
    const message = session?.messages.find((m) => m.id === messageId);
    if (
      !message ||
      message.status === "running" ||
      codeBlocks(message.content)[blockIndex] !== code ||
      !actionableCodeBlocks(message.content).some(
        (block) => block.blockIndex === blockIndex,
      )
    ) {
      throw new Error("代码块已变化或不属于当前会话，请重新查看消息。");
    }
  }

  public async showDiffView(
    code: string,
    filePath: string | undefined,
    messageId: string,
    blockIndex: number,
  ): Promise<void> {
    this.verifyCodeSource(messageId, blockIndex, code);
    const session = this.getSession();
    const sessionId = session!.id;
    const editor = vscode.window.activeTextEditor;
    let originalUri: vscode.Uri | undefined = editor?.document.uri;

    if (filePath && vscode.workspace.workspaceFolders) {
      originalUri = vscode.Uri.file(
        path.resolve(
          session?.workspaceRoot ||
            vscode.workspace.workspaceFolders[0].uri.fsPath,
          filePath,
        ),
      );
    }

    if (!originalUri) {
      throw new Error("请先打开要预览和替换的目标文件。");
    }

    const originalDocument =
      await vscode.workspace.openTextDocument(originalUri);
    if (this.getSession()?.id !== sessionId) {
      throw new Error("会话已切换，未建立预览。");
    }
    this.verifyCodeSource(messageId, blockIndex, code);
    const originalFileName = path.basename(originalUri.fsPath);
    const diffUri = vscode.Uri.parse(
      `${DiffContentProvider.scheme}:/${randomUUID()}/${encodeURIComponent(originalFileName)}-generated.tmp`,
    );
    const originalVersion = originalDocument.version;
    const originalHash = contentHash(originalDocument.getText());
    const previewId = this.previews.create({
      sessionId,
      messageId,
      blockIndex,
      target: originalUri.toString(),
      version: originalVersion,
      originalHash,
      code,
      diffUri: diffUri.toString(),
    });
    try {
      this.diffProvider.setContent(diffUri, code);
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        diffUri,
        `${originalFileName} ↔ Antigravity Suggested Changes`,
      );
      if (
        this.getSession()?.id !== sessionId ||
        originalDocument.version !== originalVersion ||
        contentHash(originalDocument.getText()) !== originalHash
      )
        throw new Error("会话或文件在打开预览时已变化，请重新预览差异。");
      this.verifyCodeSource(messageId, blockIndex, code);
      this.previews.get(previewId, sessionId, messageId, blockIndex, code);
      this.publish({
        type: "previewReady",
        sessionId,
        previewId,
        messageId,
        blockIndex,
      });
    } catch (error) {
      this.previews.remove(previewId);
      throw error;
    }
  }

  public async applyCode(
    previewId: string,
    code: string,
    messageId: string,
    blockIndex: number,
  ): Promise<void> {
    const sessionId = this.getSession()?.id || "";
    this.verifyCodeSource(messageId, blockIndex, code || "");
    const preview = this.previews.get(
      previewId,
      sessionId,
      messageId,
      blockIndex,
      code || "",
    );
    const target = vscode.Uri.parse(preview.target);
    const doc = await vscode.workspace.openTextDocument(target);
    if (
      this.getSession()?.id !== sessionId ||
      doc.version !== preview.version ||
      contentHash(doc.getText()) !== preview.originalHash
    ) {
      throw new Error("会话或文件在预览后已变化，请重新预览差异。");
    }
    this.verifyCodeSource(messageId, blockIndex, code);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      target,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      preview.code,
    );
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("应用修改失败。");
    }
    this.previews.remove(previewId);
  }
  public async openResource(href: string): Promise<void> {
    if (this.disposed) {
      throw new Error("编辑器操作已结束。");
    }

    if (/^https?:\/\//i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }

    const initialSessionId = this.getSession()?.id;
    const { filePath, line, column } = this.resolveFileReference(href);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath || href}`);
    }

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath),
    );

    if (this.disposed) {
      throw new Error("编辑器操作已结束。");
    }
    if (this.getSession()?.id !== initialSessionId) {
      throw new Error("会话已切换，操作已取消。");
    }

    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line !== undefined) {
      const targetLine = Math.max(
        0,
        Math.min(line - 1, document.lineCount - 1),
      );
      const position = new vscode.Position(
        targetLine,
        Math.max(
          0,
          Math.min((column || 1) - 1, document.lineAt(targetLine).text.length),
        ),
      );
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(document, options);
  }

  public resolveFileReference(href: string): {
    filePath?: string;
    line?: number;
    column?: number;
  } {
    const folders = vscode.workspace.workspaceFolders || [];
    const activeDirectory =
      vscode.window.activeTextEditor?.document.uri.scheme === "file"
        ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
        : undefined;
    return resolveReference(href, {
      roots: [
        this.getSession()?.workspaceRoot,
        ...folders.map((folder) => folder.uri.fsPath),
        activeDirectory,
      ],
      home: os.homedir(),
      platform: process.platform,
      exists: (candidate) => fs.existsSync(candidate),
      fileUriToPath: (uri) => vscode.Uri.parse(uri).fsPath,
    });
  }
}
