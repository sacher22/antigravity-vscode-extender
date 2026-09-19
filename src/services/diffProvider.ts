import * as vscode from "vscode";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "antigravity-diff";
  private contentMap = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public onDidChange = this.onDidChangeEmitter.event;

  public setContent(uri: vscode.Uri, text: string): void {
    this.contentMap.set(uri.toString(), text);
    this.onDidChangeEmitter.fire(uri);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentMap.get(uri.toString()) || "";
  }
}
