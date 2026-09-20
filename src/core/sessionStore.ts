import * as vscode from "vscode";
import { SessionMeta, ChatMessage } from "./types";

const SESSIONS_STORAGE_KEY = "antigravity.sessions.v1";
const CURRENT_SESSION_ID_KEY = "antigravity.currentSessionId.v1";

export class SessionStore {
  private cachedSessions: SessionMeta[] | null = null;
  private currentSessionIdCache: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public getAllSessions(): SessionMeta[] {
    if (!this.cachedSessions) {
      const data = this.context.globalState.get<SessionMeta[]>(SESSIONS_STORAGE_KEY, []);
      this.cachedSessions = Array.isArray(data)
        ? data.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        : [];
    }
    return this.cachedSessions;
  }

  public getSession(id: string): SessionMeta | undefined {
    return this.getAllSessions().find((s) => s.id === id);
  }

  public findEmptySession(): SessionMeta | undefined {
    return this.getAllSessions().find((session) => this.isEmptySession(session));
  }

  public isEmptySession(session: SessionMeta | undefined): session is SessionMeta {
    if (!session) return false;
    return (!session.messages || session.messages.length === 0) && session.title === "New Conversation";
  }

  public removeEmptySessionsExcept(keepId?: string): void {
    const sessions = this.getAllSessions();
    const filtered = sessions.filter((session) => !this.isEmptySession(session) || session.id === keepId);
    if (filtered.length === sessions.length) return;
    this.cachedSessions = filtered;
    void this.context.globalState.update(SESSIONS_STORAGE_KEY, filtered);
  }

  public getCurrentSessionId(): string | undefined {
    if (this.currentSessionIdCache !== null) {
      return this.currentSessionIdCache;
    }
    const id = this.context.globalState.get<string>(CURRENT_SESSION_ID_KEY);
    this.currentSessionIdCache = id ?? "";
    return id;
  }

  public setCurrentSessionId(id: string): void {
    this.currentSessionIdCache = id;
    void this.context.globalState.update(CURRENT_SESSION_ID_KEY, id);
  }

  public saveSession(session: SessionMeta): void {
    const sessions = this.getAllSessions();
    const index = sessions.findIndex((s) => s.id === session.id);
    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.unshift(session);
    }
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    void this.context.globalState.update(SESSIONS_STORAGE_KEY, sessions);
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

  public replaceSessionId(oldId: string, newId: string): SessionMeta | undefined {
    const sessions = this.getAllSessions();
    const session = sessions.find((s) => s.id === oldId);
    if (session) {
      session.id = newId;
      session.updatedAt = Date.now();
      this.saveSession(session);
      if (this.getCurrentSessionId() === oldId) {
        this.setCurrentSessionId(newId);
      }
    }
    return session;
  }

  public deleteSession(id: string): void {
    let sessions = this.getAllSessions();
    sessions = sessions.filter((s) => s.id !== id);
    this.cachedSessions = sessions;
    void this.context.globalState.update(SESSIONS_STORAGE_KEY, sessions);

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
