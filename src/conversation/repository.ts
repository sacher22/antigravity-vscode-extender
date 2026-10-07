import {
  transcriptBytes,
  validateTranscriptLimits,
  DEFAULT_TRANSCRIPT_LIMITS,
  TranscriptLimits,
} from "./transcriptBudget";
import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { EventEmitter } from "events";
import { SessionMeta, ChatMessage, ToolCallItem } from "../core/types";
import { initializeStorage, quarantineAsync } from "./storageInitialization";
import { WriteBudget } from "./writeBudget";
import { toolPreview, toolPreviewLimit } from "./toolPreview";
import { FingerprintCache, fingerprint } from "./fingerprintCache";
import { acquireExecutionLease, ExecutionLease } from "./executionLease";
import { writeAtomicFile } from "./atomicFile";
import { combineOperationFailures } from "../core/operationFailures";
interface CheckpointWrite {
  raw: string;
  lockId: string;
  messages: Map<
    string,
    { name: string; text: string; messageId: string; status?: string }
  >;
  tools: Map<string, { file: string; output: string }>;
  trims: Map<
    string,
    {
      tool: ToolCallItem;
      output: string;
      messageId: string;
      previewLimit: number;
    }
  >;
}
interface State {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
export interface StorageContext {
  globalStorageUri?: { fsPath: string };
  globalState: State;
  workspaceState?: State;
}
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
/** No shared mutable index. Metadata per session; only the latest page is materialized. */
export class ConversationRepository extends EventEmitter {
  public imageDirectory(id: string): string {
    if (!this.root) throw new Error("图片附件需要持久化存储。");
    return path.join(this.root, hash(id), "images");
  }
  private sessions = new Map<string, SessionMeta>();
  private loaded = new Set<string>();
  private cacheRecency = new Map<string, number>();
  private cacheClock = 0;
  private cacheTrim?: Promise<void>;
  private cacheTrimRevision = 0;
  private cacheTrimPolicy?: {
    allowed: (id: string) => boolean;
    limits: typeof DEFAULT_TRANSCRIPT_LIMITS;
  };
  private transcriptLimits = DEFAULT_TRANSCRIPT_LIMITS;
  private touchTranscript(id: string) {
    this.cacheRecency.set(id, ++this.cacheClock);
  }
  private transcriptUsage() {
    let estimatedBytes = 0;
    for (const id of this.loaded) {
      const session = this.sessions.get(id);
      if (session)
        estimatedBytes += transcriptBytes(session, this.files.get(id));
    }
    return {
      sessions: this.loaded.size,
      estimatedBytes,
      ...this.transcriptLimits,
      overBudget:
        this.loaded.size > this.transcriptLimits.maxSessions ||
        estimatedBytes > this.transcriptLimits.maxBytes,
    };
  }
  private files = new Map<string, string[]>();
  private pending = Promise.resolve();
  private failure?: Error;
  private current: string;
  private readonly root?: string;
  private saved: FingerprintCache;
  private savedTools: FingerprintCache;
  private toolPreviews = new WeakMap<ToolCallItem, string>();
  // Persistence bookkeeping survives tool-object reconstruction at checkpoints.
  // Optional LRU eviction must not queue the same uncommitted version again.
  private pendingToolFingerprints = new Map<string, string>();
  markToolPreview(tool: ToolCallItem): void {
    if (tool.output !== undefined) this.toolPreviews.set(tool, tool.output);
  }
  isToolPreview(tool: ToolCallItem): boolean {
    return (
      tool.output !== undefined && this.toolPreviews.get(tool) === tool.output
    );
  }
  private checkpointWrites = new Map<string, CheckpointWrite>();
  private metadataWrites = new Map<string, { raw: string }>();
  private releasing = new Set<string>();
  private loading = new Map<string, Promise<SessionMeta | undefined>>();
  private deleting = new Map<string, Promise<void>>();
  private leases = new Map<
    string,
    { count: number; release: ExecutionLease }
  >();
  private pendingStorageReleases = new Set<() => void>();
  private executionClaims = new Map<
    string,
    { token: symbol; native: boolean }
  >();
  private readonly writeBudget: WriteBudget;
  private failedWrites = new Set<string>();
  private pressurePublished = false;
  get cacheStats() {
    return {
      transcripts: this.transcriptUsage(),
      messages: this.saved.snapshot,
      tools: this.savedTools.snapshot,
      pendingToolFingerprints: this.pendingToolFingerprints.size,
      loadedSessions: this.loaded.size,
      fileLists: this.files.size,
    };
  }
  get writeQueueStats() {
    return {
      ...this.writeBudget.snapshot,
      paused: this.writeBudget.snapshot.paused || this.failedWrites.size > 0,
      failedSessions: this.failedWrites.size,
    };
  }
  writePausedFor(sessionId?: string) {
    return (
      this.writeBudget.snapshot.paused ||
      (!!sessionId && this.failedWrites.has(sessionId))
    );
  }
  private publishWritePressure(force = false) {
    const paused = this.writeQueueStats.paused;
    if (force || paused !== this.pressurePublished) {
      this.pressurePublished = paused;
      this.emit("storagePressure", paused);
    }
  }
  constructor(
    private readonly context: StorageContext,
    initializeSynchronously = true,
    budget?: { highBytes: number; lowBytes: number },
    cacheBudget?: { maxEntries: number; maxBytes: number },
  ) {
    super();
    this.saved = new FingerprintCache(
      cacheBudget?.maxEntries,
      cacheBudget?.maxBytes,
    );
    this.savedTools = new FingerprintCache(
      cacheBudget?.maxEntries ?? 2048,
      cacheBudget?.maxBytes ?? 1024 * 1024,
    );
    this.writeBudget = new WriteBudget(
      () => this.publishWritePressure(true),
      budget?.highBytes,
      budget?.lowBytes,
    );
    this.current = (context.workspaceState || context.globalState).get(
      "antigravity.currentSessionId.v1",
      "",
    );
    this.root =
      context.globalStorageUri &&
      path.join(context.globalStorageUri.fsPath, "conversations-v3");
    if (this.root && initializeSynchronously) {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.migrate();
      for (const dir of fs.readdirSync(this.root, { withFileTypes: true }))
        if (dir.isDirectory() && /^[a-f0-9]{64}$/.test(dir.name)) {
          try {
            const meta = JSON.parse(
              fs.readFileSync(
                path.join(this.root, dir.name, "session.json"),
                "utf8",
              ),
            );
            this.validate(meta);
            this.sessions.set(meta.id, { ...meta, messages: [] });
          } catch (e) {
            this.quarantine(path.join(this.root, dir.name), String(e));
          }
        }
    } else if (!this.root)
      for (const s of context.globalState.get<SessionMeta[]>(
        "antigravity.sessions.v1",
        [],
      )) {
        this.sessions.set(s.id, { ...s, messages: [...(s.messages || [])] });
        this.loaded.add(s.id);
      }
  }
  static async open(
    context: StorageContext,
    progress?: (message: string) => void,
  ): Promise<ConversationRepository> {
    const repository = new ConversationRepository(context, false);
    if (repository.root) {
      const sessions = await initializeStorage(
        repository.root,
        context.globalStorageUri!.fsPath,
        context.globalState.get<SessionMeta[]>("antigravity.sessions.v1", []),
        (meta) => repository.validate(meta),
        progress,
      );
      for (const session of sessions)
        repository.sessions.set(session.id, session);
      const current = repository.getCurrentSessionId();
      if (current) await repository.getSessionAsync(current);
    }
    return repository;
  }
  private validate(s: SessionMeta): void {
    if (!s || typeof s.id !== "string" || typeof s.title !== "string")
      throw new Error("Invalid conversation metadata");
  }
  private quarantine(file: string, reason: string): void {
    fs.mkdirSync(path.join(this.root!, "quarantine"), { recursive: true });
    fs.writeFileSync(
      path.join(this.root!, "quarantine", hash(file) + ".json"),
      JSON.stringify({ file, reason }),
      { mode: 0o600 },
    );
  }
  private migrate(): void {
    const marker = path.join(this.root!, "migration.json");
    if (fs.existsSync(marker)) return;
    const old = path.join(this.context.globalStorageUri!.fsPath, "sessions-v2");
    const backup = path.join(this.root!, "legacy-backup");
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    if (fs.existsSync(old))
      fs.cpSync(old, path.join(backup, "sessions-v2"), { recursive: true });
    const global = this.context.globalState.get<SessionMeta[]>(
      "antigravity.sessions.v1",
      [],
    );
    fs.writeFileSync(
      path.join(backup, "globalState.json"),
      JSON.stringify(global),
      { mode: 0o600 },
    );
    let sources: SessionMeta[] = global;
    if (fs.existsSync(path.join(old, "index.json"))) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(old, "index.json"), "utf8"),
        );
        if (!Array.isArray(parsed)) throw new Error("Invalid legacy index");
        sources = parsed;
      } catch (e) {
        this.quarantine(path.join(old, "index.json"), String(e));
      }
    }
    for (const source of sources)
      try {
        this.validate(source);
        let s = source;
        const dir = path.join(old, hash(s.id));
        const whole = path.join(old, hash(s.id) + ".json");
        let messages = source.messages || [];
        if (fs.existsSync(whole)) {
          s = JSON.parse(fs.readFileSync(whole, "utf8"));
          messages = s.messages;
        } else if (fs.existsSync(path.join(dir, "session.json"))) {
          s = JSON.parse(
            fs.readFileSync(path.join(dir, "session.json"), "utf8"),
          );
          messages = fs
            .readdirSync(path.join(dir, "messages"))
            .filter((f) => f.endsWith(".json"))
            .sort()
            .map((f) =>
              JSON.parse(
                fs.readFileSync(path.join(dir, "messages", f), "utf8"),
              ),
            );
        }
        if (!Array.isArray(messages))
          throw new Error("Invalid legacy messages");
        const target = this.dir(s.id);
        fs.mkdirSync(path.join(target, "messages"), {
          recursive: true,
          mode: 0o700,
        });
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (typeof m.content !== "string") throw new Error("Invalid message");
          m.id ||= randomUUID();
          m.toolCalls ||= m.tools;
          if (m.status === "running") m.status = "interrupted";
          fs.writeFileSync(
            path.join(
              target,
              "messages",
              `${String(i).padStart(10, "0")}-${hash(m.id).slice(0, 16)}.json`,
            ),
            JSON.stringify(m),
            { mode: 0o600 },
          );
        }
        const { messages: _, ...meta } = s;
        fs.writeFileSync(
          path.join(target, "session.json"),
          JSON.stringify({
            ...meta,
            cliConversationId:
              s.cliConversationId ||
              (!s.id.startsWith("sess_") ? s.id : undefined),
            messageCount: messages.length,
          }),
          { mode: 0o600 },
        );
      } catch (e) {
        this.quarantine(source?.id || "unknown", String(e));
      }
    fs.writeFileSync(
      marker,
      JSON.stringify({ version: 3, completedAt: Date.now() }),
      { mode: 0o600 },
    );
  }
  private dir(id: string): string {
    return path.join(this.root!, hash(id));
  }
  getAllSessions(): SessionMeta[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  getCurrentSessionId(): string | undefined {
    return this.current || undefined;
  }
  setCurrentSessionId(id: string): void {
    this.current = id;
    void (this.context.workspaceState || this.context.globalState).update(
      "antigravity.currentSessionId.v1",
      id,
    );
  }
  getSession(id: string): SessionMeta | undefined {
    const s = this.sessions.get(id);
    if (s) this.touchTranscript(id);
    if (!s || this.loaded.has(id)) return s;
    const folder = path.join(this.dir(id), "messages");
    const files = fs.existsSync(folder)
      ? fs
          .readdirSync(folder)
          .filter((f) => f.endsWith(".json"))
          .sort()
      : [];
    this.files.set(id, files);
    s.messages = this.readFiles(id, files.slice(-30));
    this.loaded.add(id);
    return s;
  }
  private readFiles(id: string, files: string[]): ChatMessage[] {
    return files.flatMap((f) => {
      try {
        const m = JSON.parse(
          fs.readFileSync(path.join(this.dir(id), "messages", f), "utf8"),
        );
        this.saved.matchesAndRemember(id + "\0" + f, JSON.stringify(m));
        for (const tool of m.toolCalls || []) {
          if (
            typeof tool.output === "string" &&
            fs.existsSync(
              path.join(
                this.dir(id),
                "tools",
                hash(m.id + "-" + tool.stepIndex) + ".txt",
              ),
            )
          )
            this.toolPreviews.set(tool, tool.output);
        }
        if (m.status === "running") m.status = "interrupted";
        return [m];
      } catch (e) {
        this.quarantine(path.join(this.dir(id), "messages", f), String(e));
        return [];
      }
    });
  }
  async getSessionAsync(id: string): Promise<SessionMeta | undefined> {
    const deletion = this.deleting.get(id);
    if (deletion) await deletion;
    const s = this.sessions.get(id);
    if (s) this.touchTranscript(id);
    if (!s || this.loaded.has(id) || !this.root) return s;
    const existing = this.loading.get(id);
    if (existing) return existing;
    const work = (async () => {
      await this.flush();
      if (this.sessions.get(id) !== s) return undefined;
      const folder = path.join(this.dir(id), "messages");
      const files = await fs.promises.readdir(folder).catch((error) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
      const names = files.filter((name) => name.endsWith(".json")).sort();
      const messages = await this.readFilesAsync(id, names.slice(-30));
      if (this.sessions.get(id) !== s) return undefined;
      if (!this.loaded.has(id)) {
        this.files.set(id, names);
        s.messages = messages;
        this.loaded.add(id);
      }
      return s;
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, work);
    return work;
  }
  private async readFilesAsync(
    id: string,
    files: string[],
  ): Promise<ChatMessage[]> {
    const toolNames = new Set(
      await fs.promises
        .readdir(path.join(this.dir(id), "tools"))
        .catch((error) => {
          if (error.code === "ENOENT") return [] as string[];
          throw error;
        }),
    );
    const records = await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await fs.promises.readFile(
            path.join(this.dir(id), "messages", file),
            "utf8",
          );
          const message = JSON.parse(raw) as ChatMessage;
          if (typeof message.content !== "string")
            throw new Error("Invalid message content");
          this.saved.matchesAndRemember(id + "\0" + file, raw);
          for (const tool of message.toolCalls || [])
            if (
              typeof tool.output === "string" &&
              toolNames.has(hash(message.id + "-" + tool.stepIndex) + ".txt")
            )
              this.toolPreviews.set(tool, tool.output);
          if (message.status === "running") message.status = "interrupted";
          return message;
        } catch (error) {
          await quarantineAsync(
            this.root!,
            path.join(this.dir(id), "messages", file),
            String(error),
          );
          if (
            (error as NodeJS.ErrnoException).code &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
          return undefined;
        }
      }),
    );
    return records.filter((message): message is ChatMessage => !!message);
  }
  async pageAsync(
    id: string,
    before: number,
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const s = await this.getSessionAsync(id);
    if (!s) return { messages: [], hasMore: false };
    if (!this.root) return this.page(id, before);
    const files = this.files.get(id) || [];
    const earliest = s.messages[0];
    const position = earliest
      ? files.findIndex((file) =>
          file.endsWith(hash(earliest.id || "").slice(0, 16) + ".json"),
        )
      : files.length;
    const end = position >= 0 ? position : files.length;
    const prior = await this.readFilesAsync(
      id,
      files.slice(Math.max(0, end - 30), end),
    );
    if (prior.length) s.messages = [...prior, ...s.messages];
    return { messages: prior, hasMore: end > 30 };
  }
  page(
    id: string,
    before: number,
  ): { messages: ChatMessage[]; hasMore: boolean } {
    const s = this.getSession(id);
    if (!s) return { messages: [], hasMore: false };
    if (!this.root) {
      const m = s.messages.filter((m) => m.timestamp < before);
      return { messages: m.slice(-30), hasMore: m.length > 30 };
    }
    const files = this.files.get(id) || [];
    const earliest = s.messages[0];
    const loadedIndex =
      earliest &&
      files.findIndex((f) =>
        f.endsWith(hash(earliest.id || "").slice(0, 16) + ".json"),
      );
    // Page cursors are exact persisted message timestamps. Read metadata only for pages already requested.
    let end =
      typeof loadedIndex === "number" && loadedIndex >= 0
        ? loadedIndex
        : files.length;
    const prior = this.readFiles(id, files.slice(Math.max(0, end - 30), end));
    if (prior.length) {
      s.messages = [...prior, ...s.messages];
    }
    return { messages: prior, hasMore: end > 30 };
  }
  isEmptySession(s?: SessionMeta): s is SessionMeta {
    return !!s && (s.messageCount ?? s.messages.length) === 0;
  }
  createSession(
    id: string,
    model: string,
    effort: string,
    title = "New Conversation",
  ): SessionMeta {
    const s: SessionMeta = {
      id,
      title,
      model,
      effort,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalTokens: 0,
      messages: [],
      messageCount: 0,
    };
    this.sessions.set(id, s);
    this.loaded.add(id);
    this.saveSession(s);
    this.setCurrentSessionId(id);
    return s;
  }
  saveSession(s: SessionMeta, dirtyMessageIds?: Iterable<string>): void {
    if (this.deleting.has(s.id))
      throw new Error("该会话正在删除，请等待操作完成。");
    if (!this.root) dirtyMessageIds = undefined;
    if (this.root && this.sessions.has(s.id) && !this.loaded.has(s.id))
      this.getSession(s.id);
    // A complete checkpoint is an ordering boundary for coalesced metadata.
    this.metadataWrites.delete(s.id);
    this.sessions.set(s.id, s);
    this.loaded.add(s.id);
    this.touchTranscript(s.id);
    const known = this.files.get(s.id) || [];
    const byId = new Map(known.map((f) => [f.split("-")[1], f]));
    const dirty = dirtyMessageIds && new Set(dirtyMessageIds);
    const candidates = dirty
      ? s.messages.filter((message) => message.id && dirty.has(message.id))
      : s.messages;
    const entries = candidates.map((m) => {
      m.id ||= randomUUID();
      m.toolCalls ||= m.tools;
      let name = byId.get(hash(m.id).slice(0, 16) + ".json");
      if (!name) {
        name = `${String(known.length).padStart(10, "0")}-${hash(m.id).slice(0, 16)}.json`;
        known.push(name);
        byId.set(hash(m.id).slice(0, 16) + ".json", name);
      }
      return [name, m] as const;
    });
    this.files.set(s.id, known);
    s.messageCount = known.length;
    s.lastMessageStatus = s.messages.at(-1)?.status || s.lastMessageStatus;
    const { messages: _, ...meta } = s;
    const raw = JSON.stringify(meta);
    const toolWrites: Array<{
      file: string;
      output: string;
    }> = [];
    const trimCandidates: Array<{
      tool: ToolCallItem;
      output: string;
      messageId: string;
      previewLimit: number;
    }> = [];
    const writes = entries.flatMap(([name, message]) => {
      const previewLimit = toolPreviewLimit(message.toolCalls?.length || 0);
      const m = {
        ...message,
        toolCalls: message.toolCalls?.map((tool) => {
          if (tool.output === undefined) return tool;
          const key = s.id + "\0" + message.id + "-" + tool.stepIndex;
          if (this.toolPreviews.get(tool) !== tool.output) {
            trimCandidates.push({
              tool,
              output: tool.output,
              messageId: message.id!,
              previewLimit,
            });
            const digest = fingerprint(tool.output);
            const cached = this.savedTools.matchesDigestAndRemember(
              key,
              digest,
            );
            if (!cached && this.pendingToolFingerprints.get(key) !== digest) {
              this.pendingToolFingerprints.set(key, digest);
              toolWrites.push({
                file: hash(message.id! + "-" + tool.stepIndex) + ".txt",
                output: tool.output,
              });
            }
          }
          return { ...tool, output: toolPreview(tool.output, previewLimit) };
        }),
      };
      const text = JSON.stringify(m);
      if (this.saved.matchesAndRemember(s.id + "\0" + name, text)) return [];
      return [{ name, text, messageId: message.id!, status: message.status }];
    });
    if (!this.root) {
      // Capture terminal identity/status before an async state write can overlap
      // a later change to the in-memory messages.
      const messages = entries.map(([, message]) => ({ ...message }));
      this.enqueue(async () => {
        await this.context.globalState.update(
          "antigravity.session.v3." + s.id,
          { ...meta, messages },
        );
        for (const message of messages) {
          try {
            this.emit("messageCommitted", {
              sessionId: s.id,
              messageId: message.id!,
              status: message.status,
            });
          } catch {
            /* Optional diagnostics cannot turn a successful write into failure. */
          }
        }
      });
      return;
    }
    const queued = this.checkpointWrites.get(s.id);
    const batch: CheckpointWrite = queued || {
      raw,
      lockId: meta.cliConversationId || meta.id,
      messages: new Map(),
      tools: new Map(),
      trims: new Map(),
    };
    batch.raw = raw;
    batch.lockId = meta.cliConversationId || meta.id;
    for (const write of writes) batch.messages.set(write.name, write);
    for (const tool of toolWrites) batch.tools.set(tool.file, tool);
    for (const trim of trimCandidates)
      batch.trims.set(trim.messageId + "-" + trim.tool.stepIndex, trim);
    this.accountCheckpoint(batch);
    if (queued) return;
    this.checkpointWrites.set(s.id, batch);
    this.enqueue(async () => {
      // The in-flight batch is immutable; new checkpoints coalesce separately.
      if (this.checkpointWrites.get(s.id) === batch)
        this.checkpointWrites.delete(s.id);
      let release: (() => void) | undefined;
      let operationFailure: unknown;
      try {
        release = this.acquire(batch.lockId);
        const dir = this.dir(s.id);
        await fs.promises.mkdir(path.join(dir, "messages"), {
          recursive: true,
          mode: 0o700,
        });
        if (batch.tools.size)
          await fs.promises.mkdir(path.join(dir, "tools"), {
            recursive: true,
            mode: 0o700,
          });
        for (const tool of batch.tools.values())
          await this.atomic(path.join(dir, "tools", tool.file), tool.output);
        for (const w of batch.messages.values()) {
          await this.atomic(path.join(dir, "messages", w.name), w.text);
          await fs.promises.appendFile(
            path.join(dir, "events.ndjson"),
            JSON.stringify({
              at: Date.now(),
              messageId: w.messageId,
              status: w.status,
              file: w.name,
            }) + "\n",
            { mode: 0o600 },
          );
        }
        await this.atomic(path.join(dir, "session.json"), batch.raw);
        for (const message of batch.messages.values()) {
          try {
            this.emit("messageCommitted", {
              sessionId: s.id,
              messageId: message.messageId,
              status: message.status,
            });
          } catch {
            /* Optional diagnostics cannot turn a successful write into failure. */
          }
        }
        for (const written of batch.trims.values()) {
          if (written.tool.output === written.output) {
            written.tool.output = toolPreview(
              written.output,
              written.previewLimit,
            );
            this.toolPreviews.set(written.tool, written.tool.output);
            const pendingKey =
              s.id + "\0" + written.messageId + "-" + written.tool.stepIndex;
            if (
              this.pendingToolFingerprints.get(pendingKey) ===
              fingerprint(written.output)
            )
              this.pendingToolFingerprints.delete(pendingKey);
            this.savedTools.delete(
              s.id + "\0" + written.messageId + "-" + written.tool.stepIndex,
            );
            this.emit("toolOutputPersisted", {
              sessionId: s.id,
              messageId: written.messageId,
              stepIndex: written.tool.stepIndex,
              output: written.output,
              preview: written.tool.output,
            });
          }
        }
        if (this.failedWrites.delete(s.id)) this.publishWritePressure(true);
      } catch (error) {
        operationFailure = error;
        throw error;
      } finally {
        try {
          this.releaseStorageReference(release, operationFailure);
        } finally {
          this.writeBudget.release(batch);
        }
      }
    }, s.id);
  }
  private accountCheckpoint(batch: CheckpointWrite) {
    let retained = batch.raw.length * 2;
    for (const message of batch.messages.values())
      retained += message.text.length * 2;
    for (const tool of batch.tools.values()) retained += tool.output.length * 2;
    for (const trim of batch.trims.values()) retained += trim.output.length * 2;
    this.writeBudget.retain(batch, retained);
  }
  /** Only draft/attachment changes can join a pending full checkpoint. */
  saveDraftMetadata(s: SessionMeta): void {
    if (this.deleting.has(s.id))
      throw new Error("该会话正在删除，请等待操作完成。");
    const checkpoint = this.checkpointWrites.get(s.id);
    if (checkpoint) {
      // Preserve the queued execution/config metadata; merge only the draft.
      const metadata = JSON.parse(checkpoint.raw);
      metadata.draft = s.draft;
      metadata.attachment = s.attachment;
      metadata.imageDirectory = s.imageDirectory;
      checkpoint.raw = JSON.stringify(metadata);
      this.accountCheckpoint(checkpoint);
      return;
    }
    this.saveMetadata(s);
  }
  /** Draft/config updates never enumerate or serialize chat/tool history. */
  saveMetadata(s: SessionMeta): void {
    // Preserve queue ordering across explicit metadata/config commits.
    this.checkpointWrites.delete(s.id);
    if (this.deleting.has(s.id))
      throw new Error("该会话正在删除，请等待操作完成。");
    if (!this.root) {
      this.saveSession(s);
      return;
    }
    this.sessions.set(s.id, s);
    const { messages: _, ...metadata } = s;
    const raw = JSON.stringify(metadata);
    const queued = this.metadataWrites.get(s.id);
    if (queued) {
      queued.raw = raw;
      this.writeBudget.retain(queued, raw.length * 2);
      return;
    }
    const entry = { raw };
    this.metadataWrites.set(s.id, entry);
    this.writeBudget.retain(entry, raw.length * 2);
    this.enqueue(async () => {
      if (this.metadataWrites.get(s.id) === entry)
        this.metadataWrites.delete(s.id);
      let release: (() => void) | undefined;
      let operationFailure: unknown;
      try {
        release = this.acquire(s.cliConversationId || s.id);
        await fs.promises.mkdir(this.dir(s.id), {
          recursive: true,
          mode: 0o700,
        });
        await this.atomic(path.join(this.dir(s.id), "session.json"), entry.raw);
      } catch (error) {
        operationFailure = error;
        throw error;
      } finally {
        try {
          this.releaseStorageReference(release, operationFailure);
        } finally {
          this.writeBudget.release(entry);
        }
      }
    }, s.id);
  }
  /** Only durable, explicitly releasable transcripts participate in LRU eviction. */
  trimTranscriptCache(
    allowed: (id: string) => boolean,
    limits = DEFAULT_TRANSCRIPT_LIMITS,
  ): Promise<void> {
    validateTranscriptLimits(limits);
    this.transcriptLimits = { ...limits };
    if (!this.root) return Promise.resolve();
    this.cacheTrimPolicy = { allowed, limits: { ...limits } };
    ++this.cacheTrimRevision;
    if (this.cacheTrim) return this.cacheTrim;
    const work = (async () => {
      let revision: number;
      do {
        await this.flush();
        revision = this.cacheTrimRevision;
        const policy = this.cacheTrimPolicy!;
        const entries = [...this.loaded]
          .map((id) => ({
            id,
            bytes: transcriptBytes(this.sessions.get(id)!, this.files.get(id)),
            recency: this.cacheRecency.get(id) || 0,
          }))
          .sort((a, b) => a.recency - b.recency);
        let count = entries.length,
          bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
        for (const entry of entries) {
          if (revision !== this.cacheTrimRevision) break;
          if (
            count <= policy.limits.maxSessions &&
            bytes <= policy.limits.maxBytes
          )
            break;
          const releasable = () =>
            !!this.cacheTrimPolicy?.allowed(entry.id) &&
            !this.loading.has(entry.id) &&
            !this.deleting.has(entry.id) &&
            !this.failedWrites.has(entry.id);
          if (!releasable()) continue;
          await this.releaseTranscript(entry.id, releasable);
          if (!this.loaded.has(entry.id)) {
            count--;
            bytes -= entry.bytes;
          }
        }
      } while (revision !== this.cacheTrimRevision);
    })().finally(() => {
      if (this.cacheTrim === work) {
        this.cacheTrim = undefined;
        this.cacheTrimPolicy = undefined;
      }
    });
    this.cacheTrim = work;
    return work;
  }
  /** Execution and child discovery survive eviction of persisted UI transcript caches. */
  async releaseTranscript(id: string, allowed: () => boolean): Promise<void> {
    if (!this.root || this.releasing.has(id)) return;
    this.releasing.add(id);
    try {
      await this.flush();
      if (!allowed()) return;
      const session = this.sessions.get(id);
      if (!session) return;
      session.messages = [];
      this.loaded.delete(id);
      this.cacheRecency.delete(id);
      this.files.delete(id);
      for (const key of this.saved.keys())
        if (key.startsWith(id + "\0")) this.saved.delete(key);
      for (const key of this.savedTools.keys())
        if (key.startsWith(id + "\0")) this.savedTools.delete(key);
      for (const key of this.pendingToolFingerprints.keys())
        if (key.startsWith(id + "\0")) this.pendingToolFingerprints.delete(key);
    } finally {
      this.releasing.delete(id);
    }
  }
  toolOutput(
    id: string,
    messageId: string,
    step: number,
    offset = 0,
  ): { output: string; hasMore: boolean; nextOffset: number } {
    const f =
      this.root &&
      path.join(this.dir(id), "tools", hash(messageId + "-" + step) + ".txt");
    if (!f || !fs.existsSync(f))
      return { output: "", hasMore: false, nextOffset: offset };
    const fd = fs.openSync(f, "r");
    try {
      const b = Buffer.alloc(65536);
      let n = fs.readSync(fd, b, 0, b.length, offset);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (let trim = 0; trim < 4; trim++) {
        try {
          decoder.decode(b.subarray(0, n));
          break;
        } catch {
          n--;
        }
      }
      return {
        output: b.subarray(0, n).toString("utf8"),
        hasMore: fs.fstatSync(fd).size > offset + n,
        nextOffset: offset + n,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  async toolOutputAsync(
    id: string,
    messageId: string,
    step: number,
    offset = 0,
  ): Promise<{ output: string; hasMore: boolean; nextOffset: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("工具输出页码无效。");
    if (!this.root) return { output: "", hasMore: false, nextOffset: offset };
    const file = path.join(
      this.dir(id),
      "tools",
      hash(messageId + "-" + step) + ".txt",
    );
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { output: "", hasMore: false, nextOffset: offset };
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (offset > size) throw new Error("工具输出已变化，请重新展开。");
      const bytes = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      let length = bytesRead;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      // Returned offsets always end at a code point boundary. Reject malformed
      // data/start offsets instead of silently returning replacement characters.
      for (;;) {
        try {
          const output = decoder.decode(bytes.subarray(0, length));
          return {
            output,
            hasMore: offset + length < size,
            nextOffset: offset + length,
          };
        } catch (error) {
          if (
            bytesRead - length >= 3 ||
            length === 0 ||
            offset + bytesRead === size
          )
            throw new Error("工具输出不是完整 UTF-8，请查看原文文件。");
          length--;
        }
      }
    } finally {
      await handle.close();
    }
  }
  /** Execution is exclusive even when storage transactions share a repository. */
  hasNativeExecution(id: string): boolean {
    return this.executionClaims.get(id)?.native === true;
  }
  acquireExecution(id: string, native = false): ExecutionLease {
    if (this.executionClaims.has(id))
      throw new Error(
        "此 CLI 会话已有执行器或原生终端持有，请等待其结束后再恢复。",
      );
    const releaseLease = this.acquire(id);
    const token = Symbol(id);
    this.executionClaims.set(id, { token, native });
    if (native) this.emit("nativeExecutionChanged", id);
    let released = false;
    const release = () => {
      if (released) return;
      releaseLease();
      released = true;
      if (this.executionClaims.get(id)?.token === token)
        this.executionClaims.delete(id);
      if (native) this.emit("nativeExecutionChanged", id);
    };
    const currentLease = () => {
      if (released || this.executionClaims.get(id)?.token !== token)
        throw new Error("执行声明已失效。");
      return this.leases.get(id)?.release;
    };
    return Object.assign(release, {
      markExecutionPending: () => currentLease()?.markExecutionPending(),
      bindProcess: (pid: number) => currentLease()?.bindProcess(pid),
    });
  }
  acquire(id: string): () => void {
    if (!this.root) return () => undefined;
    const existing = this.leases.get(id);
    if (existing) {
      existing.count++;
      return this.releaseReference(id, existing);
    }
    const lease = {
      count: 1,
      release: acquireExecutionLease(
        path.join(this.root, "locks", hash(id) + ".lock"),
      ),
    };
    this.leases.set(id, lease);
    return this.releaseReference(id, lease);
  }
  private releaseReference(
    id: string,
    lease: { count: number; release: ExecutionLease },
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      if (lease.count === 1) {
        lease.release();
        if (this.leases.get(id) === lease) this.leases.delete(id);
      }
      lease.count--;
      released = true;
    };
  }
  deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (this.hasNativeExecution(session?.cliConversationId || id))
      return Promise.reject(
        new Error("此会话已在原生 CLI 中打开，请先关闭其终端再删除。"),
      );
    const existing = this.deleting.get(id);
    if (existing) return existing;
    const operation = this.enqueue(async () => {
      if (this.hasNativeExecution(session?.cliConversationId || id))
        throw new Error("此会话已在原生 CLI 中打开，请先关闭其终端再删除。");
      const release = this.acquire(session?.cliConversationId || id);
      let operationFailure: unknown;
      try {
        let tombstone: string | undefined;
        if (this.root && session) {
          tombstone = path.join(
            this.root,
            `.deleted-${hash(id)}-${randomUUID()}`,
          );
          try {
            await fs.promises.rename(this.dir(id), tombstone);
          } catch (error) {
            // A never-saved empty session legitimately has no directory.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            tombstone = undefined;
          }
        } else if (!this.root && session) {
          await this.context.globalState.update(
            "antigravity.sessions.v1",
            [...this.sessions.values()].filter((record) => record.id !== id),
          );
          try {
            await this.context.globalState.update(
              "antigravity.session.v3." + id,
              undefined,
            );
          } catch {
            this.emit(
              "cleanupWarning",
              "会话已删除，旧兼容存储项尚未清理。重新删除原会话 ID 可重试。",
            );
          }
        }
        // Rename is the deletion commit point. A failed rename leaves the
        // conversation, selection, drafts and caches intact for retry.
        this.sessions.delete(id);
        if (this.failedWrites.delete(id)) this.publishWritePressure(true);
        this.loaded.delete(id);
        this.cacheRecency.delete(id);
        this.files.delete(id);
        this.metadataWrites.delete(id);
        for (const key of this.saved.keys())
          if (key.startsWith(id + "\0")) this.saved.delete(key);
        for (const key of this.savedTools.keys())
          if (key.startsWith(id + "\0")) this.savedTools.delete(key);
        for (const key of this.pendingToolFingerprints.keys())
          if (key.startsWith(id + "\0"))
            this.pendingToolFingerprints.delete(key);
        if (this.current === id) this.setCurrentSessionId("");
        if (tombstone) {
          try {
            await fs.promises.rm(tombstone, { recursive: true, force: true });
          } catch (error) {
            this.emit(
              "cleanupWarning",
              `会话已删除，但磁盘清理尚未完成。保留目录：${tombstone}。可再次请求删除原会话 ID 重试清理。`,
            );
          }
        } else if (this.root && !session) {
          // An explicit repeated deletion retries only this ID's tombstones.
          for (const entry of await fs.promises.readdir(this.root))
            if (entry.startsWith(`.deleted-${hash(id)}-`))
              await fs.promises.rm(path.join(this.root, entry), {
                recursive: true,
                force: true,
              });
        } else if (!this.root && !session) {
          await this.context.globalState.update(
            "antigravity.session.v3." + id,
            undefined,
          );
        }
      } catch (error) {
        operationFailure = error;
        throw error;
      } finally {
        this.releaseStorageReference(release, operationFailure);
      }
    });
    const result = operation
      .catch((error) => {
        if (this.failure === error) this.failure = undefined;
        throw error;
      })
      .finally(() => this.deleting.delete(id));
    // Legacy callers may only await flush(); keep their ignored promise safe.
    void result.catch(() => undefined);
    this.deleting.set(id, result);
    return result;
  }
  updateSessionMessages(id: string, messages: ChatMessage[], tokens = 0): void {
    const s = this.getSession(id);
    if (s) {
      s.messages = messages;
      s.totalTokens += tokens;
      this.saveSession(s);
    }
  }
  updateSessionTitle(id: string, title: string): void {
    const s = this.getSession(id);
    if (s) {
      s.title = title;
      this.saveSession(s);
    }
  }
  /** Retain only failed storage cleanup; live execution claims keep their own owner. */
  private releaseStorageReference(
    release: (() => void) | undefined,
    operationFailure?: unknown,
  ): void {
    if (!release) return;
    try {
      release();
      this.pendingStorageReleases.delete(release);
    } catch (error) {
      this.pendingStorageReleases.add(release);
      throw combineOperationFailures(operationFailure, error);
    }
  }
  private async atomic(file: string, raw: string): Promise<void> {
    return writeAtomicFile(file, raw, () =>
      this.emit(
        "cleanupWarning",
        "未提交的临时记录清理失败；原记录保留，请核对存储目录。",
      ),
    );
  }
  private enqueue(
    work: () => Promise<void>,
    sessionId?: string,
  ): Promise<void> {
    const operation = this.pending.then(work);
    this.pending = operation.catch((e) => {
      this.failure = e;
      this.saved.clear();
      this.savedTools.clear();
      this.pendingToolFingerprints.clear();
      if (sessionId) {
        this.failedWrites.add(sessionId);
        this.publishWritePressure(true);
      }
      this.emit("storageError", e);
    });
    return operation;
  }
  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
    // Explicit flush retries failed physical cleanup without polling or model work.
    let cleanupFailure: unknown;
    for (const release of this.pendingStorageReleases) {
      try {
        this.releaseStorageReference(release);
      } catch (error) {
        cleanupFailure = combineOperationFailures(cleanupFailure, error);
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
}
