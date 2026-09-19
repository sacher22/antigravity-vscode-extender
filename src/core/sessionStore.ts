import * as vscode from "vscode";
import { SessionMeta, ChatMessage } from "./types";

const SESSIONS_STORAGE_KEY = "antigravity.sessions.v1";
const CURRENT_SESSION_ID_KEY = "antigravity.currentSessionId.v1";

export class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public getAllSessions(): SessionMeta[] {
    const data = this.context.globalState.get<SessionMeta[]>(SESSIONS_STORAGE_KEY, []);
    return data.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getSession(id: string): SessionMeta | undefined {
    const sessions = this.getAllSessions();
    return sessions.find((s) => s.id === id);
  }

  public getCurrentSessionId(): string | undefined {
    return this.context.globalState.get<string>(CURRENT_SESSION_ID_KEY);
  }

  public setCurrentSessionId(id: string): void {
    this.context.globalState.update(CURRENT_SESSION_ID_KEY, id);
  }

  public saveSession(session: SessionMeta): void {
    const sessions = this.getAllSessions();
    const index = sessions.findIndex((s) => s.id === session.id);
    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.unshift(session);
    }
    this.context.globalState.update(SESSIONS_STORAGE_KEY, sessions);
  }

  public createSession(id: string, model: string, effort: string, title?: string): SessionMeta {
    const newSession: SessionMeta = {
      id,
      title: title || "New Conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      effort,
      totalTokens: 0,
      messages: []
    };
    this.saveSession(newSession);
    this.setCurrentSessionId(id);
    return newSession;
  }

  public deleteSession(id: string): void {
    let sessions = this.getAllSessions();
    sessions = sessions.filter((s) => s.id !== id);
    this.context.globalState.update(SESSIONS_STORAGE_KEY, sessions);

    if (this.getCurrentSessionId() === id) {
      const next = sessions[0]?.id || "";
      this.setCurrentSessionId(next);
    }
  }

  public updateSessionMessages(id: string, messages: ChatMessage[], totalTokens?: number): void {
    const session = this.getSession(id);
    if (session) {
      session.messages = messages;
      session.updatedAt = Date.now();
      if (totalTokens !== undefined) {
        session.totalTokens = (session.totalTokens || 0) + totalTokens;
      }
      this.saveSession(session);
    }
  }

  public updateSessionTitle(id: string, title: string): void {
    const session = this.getSession(id);
    if (session) {
      session.title = title;
      session.updatedAt = Date.now();
      this.saveSession(session);
    }
  }
}
