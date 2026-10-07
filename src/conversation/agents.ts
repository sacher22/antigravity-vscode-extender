import * as fs from "fs";
import { readJsonlPage, readJsonlPageAsync, publicLogRole } from "./jsonl";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { cursorFor, validateCursor } from "./logCursor";
import type {
  NativeLogCursor,
  AgentSummary,
  StepUpdatePayload,
} from "../core/types";

/** Native IDs and JSONL only. No extra CLI/model calls and no full-history polling. */
export class AgentRegistry {
  private agents = new Map<string, AgentSummary>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer?: NodeJS.Timeout;
  private watching = false;
  private watchEpoch = 0;
  private pendingWatches = new Set<string>();
  private watcherUris = new Map<string, string | undefined>();
  private cursors = new Map<string, NativeLogCursor>();
  private reads = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(
    saved: AgentSummary[],
    private readonly changed: (persist?: boolean) => void,
    private readonly brainRoot = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
    ),
  ) {
    for (const a of saved)
      this.agents.set(a.id, {
        ...a,
        state: ["running"].includes(a.state) ? "unknown" : a.state,
      });
  }
  snapshot() {
    return Array.from(this.agents.values(), (a) => ({ ...a }));
  }
  ingest(step: StepUpdatePayload) {
    let changed = false;
    for (const item of step.subagent_info?.subagents || []) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.conversation_id || "")) continue;
      const old = this.agents.get(item.conversation_id);
      const agent: AgentSummary = {
        ...old,
        id: item.conversation_id,
        role: (item.role || old?.role || "子代理").slice(0, 256),
        typeName: (item.type_name || old?.typeName || "agent").slice(0, 128),
        state: old?.state || "running",
        logUri: item.log_uri || old?.logUri,
        workspaceUris: item.workspace_uris || old?.workspaceUris,
        startedAt: old?.startedAt || Date.now(),
        updatedAt: Date.now(),
      };
      this.agents.set(agent.id, agent);
      changed = true;
    }
    if (step.tool_name === "manage_subagents" && step.tool_info?.output) {
      const output = step.tool_info.output;
      const start = output.indexOf("[");
      try {
        const items = JSON.parse(output.slice(start));
        if (Array.isArray(items))
          for (const item of items) {
            const a = this.agents.get(item.conversationId);
            if (
              a &&
              ["running", "idle", "killed", "failed", "done", "error"].includes(
                item.state,
              )
            ) {
              a.state =
                item.state === "done"
                  ? "idle"
                  : item.state === "error"
                    ? "failed"
                    : item.state;
              a.updatedAt = Date.now();
              changed = true;
            }
          }
      } catch {
        /* A tool's prose is never guessed into a state. */
      }
    }
    if (changed) {
      this.changed();
      if (this.watching) this.watch(true);
    }
  }
  rootFinished() {
    let changed = false;
    for (const a of this.agents.values())
      if (a.state === "running") {
        a.elapsedSeconds = (Date.now() - a.startedAt) / 1000;
        a.state = "unknown";
        a.updatedAt = Date.now();
        changed = true;
      }
    if (changed) this.changed();
  }
  private logPath(a: AgentSummary): string {
    if (!a.logUri) throw new Error("CLI 尚未提供该子代理的对话日志。");
    const url = new URL(a.logUri);
    if (url.protocol !== "file:" || url.hostname)
      throw new Error("不支持的子代理日志地址。");
    const file = fileURLToPath(url);
    const allowed = path.join(
      this.brainRoot,
      a.id,
      ".system_generated",
      "logs",
    );
    const real = fs.realpathSync(file),
      dir = fs.realpathSync(allowed);
    if (!real.startsWith(dir + path.sep))
      throw new Error("子代理日志不在 CLI 会话日志目录中。");
    return real;
  }
  private async logPathAsync(a: AgentSummary): Promise<string> {
    if (!a.logUri) throw new Error("CLI 尚未提供该子代理的对话日志。");
    const url = new URL(a.logUri);
    if (url.protocol !== "file:" || url.hostname)
      throw new Error("不支持的子代理日志地址。");
    const allowed = path.join(
      this.brainRoot,
      a.id,
      ".system_generated",
      "logs",
    );
    const [real, directory] = await Promise.all([
      fs.promises.realpath(fileURLToPath(url)),
      fs.promises.realpath(allowed),
    ]);
    if (!real.startsWith(directory + path.sep))
      throw new Error("子代理日志不在 CLI 会话日志目录中。");
    return real;
  }
  /** Serialized per agent; offset zero explicitly opens a fresh view. */
  detailAsync(id: string, offset = 0) {
    const read = (this.reads.get(id) || Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) throw new Error("子代理面板已关闭。");
        const a = this.agents.get(id);
        if (!a) throw new Error("子代理不存在。");
        const uri = a.logUri;
        const prior = offset ? this.cursors.get(id) : undefined;
        if (offset && (!prior || prior.offset !== offset))
          throw new Error("子代理日志页码已失效，请重新打开子代理对话。");
        const file = await this.logPathAsync(a);
        const handle = await fs.promises.open(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const before = await cursorFor(handle, offset);
          if (prior) validateCursor(before, prior);
          const page = await readJsonlPageAsync(handle, offset);
          validateCursor(await cursorFor(handle, offset), before);
          // Re-resolve the named path after reading: an open descriptor alone
          // cannot detect rename/replacement of the path during the read.
          const named = await fs.promises.stat(await this.logPathAsync(a), {
            bigint: true,
          });
          if (
            `${named.dev}:${named.ino}:${named.birthtimeNs}` !== before.fileId
          )
            throw new Error("子代理日志已替换，请重新打开子代理对话。");
          const cursor = await cursorFor(handle, page.nextOffset);
          if (this.disposed || this.agents.get(id)?.logUri !== uri)
            throw new Error("子代理日志来源已变更，请重新打开对话。");
          this.cursors.set(id, cursor);
          return this.projectPage(page);
        } finally {
          await handle.close();
        }
      });
    this.reads.set(id, read);
    void read
      .finally(() => {
        if (this.reads.get(id) === read) this.reads.delete(id);
      })
      .catch(() => undefined);
    return read;
  }
  private projectPage(page: {
    bytes: Buffer;
    nextOffset: number;
    hasMore: boolean;
  }) {
    const lines: string[] = [];
    for (const line of page.bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const kind = publicLogRole(record, true);
        const role =
          kind === "assistant" ? "子代理" : kind === "user" ? "用户" : "任务";
        if (kind && record.content)
          lines.push(
            `${role} · ${record.type || "message"} · ${record.status || ""}\n${record.content}`,
          );
      } catch {
        lines.push("[日志记录尚未完成或超过单页限制，内容未解析]");
      }
    }
    return {
      text: lines.join("\n\n"),
      nextOffset: page.nextOffset,
      hasMore: page.hasMore,
    };
  }
  detail(id: string, offset = 0) {
    const a = this.agents.get(id);
    if (!a) throw new Error("子代理不存在。");
    const file = this.logPath(a);
    const fd = fs.openSync(file, "r");
    try {
      return this.projectPage(readJsonlPage(fd, offset));
    } finally {
      fs.closeSync(fd);
    }
  }
  watch(enabled: boolean) {
    this.watching = enabled && !this.disposed;
    if (!this.watching) {
      this.watchEpoch++;
      for (const w of this.watchers.values()) w.close();
      this.watchers.clear();
      this.watcherUris.clear();
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    const epoch = this.watchEpoch;
    for (const a of this.agents.values()) {
      if (this.watchers.has(a.id) && this.watcherUris.get(a.id) !== a.logUri) {
        this.watchers.get(a.id)?.close();
        this.watchers.delete(a.id);
        this.watcherUris.delete(a.id);
      }
      const key = `${epoch}:${a.id}:${a.logUri}`;
      if (this.watchers.has(a.id) || this.pendingWatches.has(key)) continue;
      this.pendingWatches.add(key);
      const uri = a.logUri;
      void this.logPathAsync(a)
        .then((file) => {
          if (
            !this.watching ||
            epoch !== this.watchEpoch ||
            this.agents.get(a.id)?.logUri !== uri
          )
            return;
          const watcher = fs.watch(file, () => {
            if (this.watching && epoch === this.watchEpoch && !this.timer)
              this.timer = setTimeout(() => {
                this.timer = undefined;
                this.changed(false);
              }, 100);
          });
          watcher.on("error", () => {
            watcher.close();
            if (this.watchers.get(a.id) === watcher) {
              this.watchers.delete(a.id);
              this.watcherUris.delete(a.id);
            }
          });
          this.watchers.set(a.id, watcher);
          this.watcherUris.set(a.id, uri);
        })
        .catch(() => {
          /* Missing logs retry on a native event/explicit refresh; never poll. */
        })
        .finally(() => this.pendingWatches.delete(key));
    }
  }
  dispose() {
    this.disposed = true;
    this.watch(false);
    this.cursors.clear();
  }
}
