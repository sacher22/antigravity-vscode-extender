import * as vscode from 'vscode';
import * as path from 'node:path';
import { appendContext, contextItems, combineContext, CONTEXT_BYTES } from '../core/contextAttachments';
import { contentHash } from './codePreviews';
import type { ContextAttachment, SessionMeta } from '../core/types';

export class ContextAdapter {
  private disposed = false;
  private commitQueue: Promise<void> = Promise.resolve();
  private pendingCommits = 0;

  constructor(
    private readonly getSession: () => SessionMeta | null | undefined,
    private readonly prepareSession: () => SessionMeta,
    private readonly save: (
      sessionId: string,
      attachment: NonNullable<SessionMeta['attachment']>,
    ) => Promise<void>,
  ) {}

  public dispose(): void {
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('上下文操作已结束。');
    }
  }

  private checkSession(sessionId: string): void {
    this.assertNotDisposed();
    if (this.getSession()?.id !== sessionId) {
      throw new Error('会话已切换，请重新添加文件上下文。');
    }
  }

  private enqueueCommit(task: () => Promise<void>): Promise<void> {
    if (this.pendingCommits >= 16) return Promise.reject(
      new Error('上下文保存队列繁忙（最多 16 项），请等待后重试。'),
    );
    this.pendingCommits++;
    const chained = this.commitQueue.then(task).finally(() => {
      this.pendingCommits--;
    });
    // Keep only a settled void tail. A failed save must not poison later commits.
    this.commitQueue = chained.then(() => {}, () => {});
    return chained;
  }

  private async commitItems(
    sessionId: string,
    items: ContextAttachment[],
  ): Promise<void> {
    if (!items.length) return;
    // Bound each queued payload before retaining it behind a slow save.
    combineContext(items);
    return this.enqueueCommit(async () => {
      this.checkSession(sessionId);
      const session = this.getSession()!;
      let updated = session.attachment;
      for (const item of items) {
        updated = appendContext(updated, item);
      }
      if (!updated) return;
      this.checkSession(sessionId);
      await this.save(sessionId, updated);
    });
  }

  public async sendCodeContext(
    code: string,
    fileName?: string,
    lineCount?: number,
    title?: string,
    details?: Partial<ContextAttachment>,
  ): Promise<void> {
    this.assertNotDisposed();
    const session = this.getSession() ?? this.prepareSession();
    if (Buffer.byteLength(code, 'utf8') > CONTEXT_BYTES)
      throw new Error('上下文超过 1 MiB；内容未截断。');
    const item: ContextAttachment = {
      file: fileName,
      lineCount,
      title,
      ...details,
      code,
      fingerprint: contentHash(code),
    };
    await this.commitItems(session.id, [item]);
  }

  public async request(
    type: 'problems' | 'git' | 'file' | 'selection',
  ): Promise<void> {
    this.assertNotDisposed();
    if (type === 'git') return;

    const session = this.getSession() ?? this.prepareSession();
    const sessionId = session.id;

    if (type === 'problems') {
      const allDiagnostics = vscode.languages.getDiagnostics();
      let report = '';
      let reportBytes = 0;
      let count = 0;
      let omitted = 0;

      const meta = session as {
        workspaceDirectories?: string[];
        workspaceRoot?: string;
      };
      const roots =
        meta.workspaceDirectories && meta.workspaceDirectories.length > 0
          ? meta.workspaceDirectories
          : [
              ...(meta.workspaceRoot ? [meta.workspaceRoot] : []),
              ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ||
                []),
            ];

      const appendReport = (chunk: string): void => {
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (reportBytes + chunkBytes > CONTEXT_BYTES) {
          throw new Error('诊断信息超过 1 MiB；请排查长诊断信息，内容未截断。');
        }
        reportBytes += chunkBytes;
        report += chunk;
      };

      for (const [uri, diags] of allDiagnostics) {
        const resolvedUri = path.resolve(uri.fsPath);
        const isInWorkspace = roots.some((root) => {
          const resolvedRoot = path.resolve(root);
          const prefix = resolvedRoot.endsWith(path.sep)
            ? resolvedRoot
            : resolvedRoot + path.sep;
          return (
            resolvedUri === resolvedRoot || resolvedUri.startsWith(prefix)
          );
        });
        if (!isInWorkspace) continue;

        const errors = diags.filter(
          (d) =>
            d.severity === vscode.DiagnosticSeverity.Error ||
            d.severity === vscode.DiagnosticSeverity.Warning,
        );
        if (errors.length > 0) {
          if (count >= 100) {
            omitted += errors.length;
            continue;
          }
          appendReport(`File: ${path.basename(uri.fsPath)} (${uri.fsPath})\n`);
          for (const d of errors) {
            if (count >= 100) {
              omitted++;
              continue;
            }
            appendReport(
              `  Line ${d.range.start.line + 1}: [${d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning'}] ${d.message}\n`,
            );
            count++;
          }
        }
      }

      if (count === 0) {
        vscode.window.showInformationMessage(
          'Antigravity: No problems/errors found in workspace!',
        );
        return;
      }
      if (omitted > 0) {
        appendReport(`\n已省略 ${omitted} 条诊断（最多 100 条）。`);
      }
      await this.sendCodeContext(
        report,
        'Workspace Problems',
        count,
        'Fix Problems in Workspace',
      );
    } else if (type === 'file') {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        title: 'Select file to attach as context',
      });
      this.checkSession(sessionId);
      if (!uris || uris.length === 0) return;

      let staged: SessionMeta['attachment'];
      for (const uri of uris) {
        const doc = await vscode.workspace.openTextDocument(uri);
        this.checkSession(sessionId);
        const code = doc.getText();
        if (Buffer.byteLength(code, 'utf8') > CONTEXT_BYTES)
          throw new Error('上下文超过 1 MiB；内容未截断。');
        staged = appendContext(staged, {
          code,
          file: uri.fsPath,
          uri: uri.toString(),
          lineCount: doc.lineCount,
          version: doc.version,
          fingerprint: contentHash(code),
        });
      }
      await this.commitItems(sessionId, contextItems(staged));
    } else if (type === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        throw new Error('请先在 VS Code 编辑器中选择要添加的片段。');
      }
      const sel = editor.selection;
      const code = editor.document.getText(sel);
      await this.sendCodeContext(
        code,
        editor.document.uri.fsPath,
        undefined,
        '选区',
        {
          uri: editor.document.uri.toString(),
          version: editor.document.version,
          range: {
            start: { line: sel.start.line, character: sel.start.character },
            end: { line: sel.end.line, character: sel.end.character },
          },
        },
      );
    }
  }
}
