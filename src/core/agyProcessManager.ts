import { ChildProcess, spawn } from "child_process";
import * as readline from "readline";
import { EventEmitter } from "events";
import { AgyIncomingEvent } from "./types";
import { waitForProcessGroupExit } from "./processGroup";
import { OperationCancelledError, ProcessExitUnconfirmedError } from "./operationErrors";
import { buildCliArguments } from "./cliArguments";
import { CliStderrSummary } from "./cliStderrSummary";

export interface AgyProcessOptions {
  cliPath: string;
  cwd: string;
  model?: string;
  agent?: string;
  effort?: string;
  dangerouslySkipPermissions?: boolean;
  isPlanMode?: boolean;
  conversationId?: string;
  createProject?: boolean;
  additionalDirectories?: string[];
  sandbox?: boolean;
  schemaPath?: string;
}
export interface AgyExitInfo {
  code: number | null;
  signal: string | null;
  generation: number;
  exitConfirmed?: boolean;
}

/** Owns one CLI process group. Every callback is fenced by its generation. */
export class AgyProcessManager extends EventEmitter {
  private stderrSummary = new CliStderrSummary();
  get stderrDiagnostics() {return this.stderrSummary.snapshot();}
  get processPid() {return this.childProcess?.pid;}
  private childProcess: ChildProcess | null = null;
  private generation = 0;
  private lifecycle = 0;
  private ready = false;
  private pendingInitReject?: (error: Error) => void;
  private stopping?: Promise<void>;
  private unconfirmedGroup?: number;
  get terminationUnconfirmed() {return this.unconfirmedGroup !== undefined;}
  get exitConfirmed() {return !this.childProcess && !this.stopping && !this.unconfirmedGroup;}
  private outputReader?: readline.Interface;
  private outputPaused = false;
  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused;
    if (!this.ready) return;
    if (paused) this.outputReader?.pause();
    else this.outputReader?.resume();
  }
  public initInfo: Record<string, unknown> = {};
  public activeConversationId: string | null = null;
  constructor(
    private readonly log: (message: string) => void = () => undefined,
  ) {
    super();
  }
  get active(): boolean {
    return this.ready && this.childProcess !== null;
  }
  get currentGeneration(): number {
    return this.generation;
  }

  async start(options: AgyProcessOptions): Promise<string> {
    const ticket = ++this.lifecycle;
    await this.stopChild("SIGTERM", 500);
    if (ticket !== this.lifecycle)
      throw new OperationCancelledError("Antigravity process initialization was cancelled");
    const generation = ++this.generation;
    const child = spawn(options.cliPath, this.buildArgs(options), {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.childProcess = child;
    try {if (child.pid) this.emit("spawned", child.pid);}
    catch(error) {await this.stopChild("SIGTERM", 100); throw error;}
    this.ready = false;
    this.activeConversationId = null;
    this.initInfo = {};
    this.log(
      `process start generation=${generation} cwd=${options.cwd} model=${options.model} permission=${options.dangerouslySkipPermissions ? "auto" : "review"}`,
    );
    const stdout = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    this.outputReader = stdout;
    const stderrSummary = new CliStderrSummary();
    this.stderrSummary = stderrSummary;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pendingInitReject === fail) this.pendingInitReject = undefined;
        reject(error);
      };
      this.pendingInitReject = fail;
      const timer = setTimeout(() => {
        fail(new Error("Timed out after 30s waiting for Antigravity init"));
        void this.stop();
      }, 30_000);
      const live = () =>
        generation === this.generation && child === this.childProcess;
      stdout.on("line", (line) => {
        if (!live() || !line.trim()) return;
        let event: AgyIncomingEvent;
        try {
          event = JSON.parse(line);
        } catch {
          this.emit("raw_output", line.length);
          return;
        }
        if (
          !event ||
          typeof event !== "object" ||
          typeof event.event !== "string"
        )
          return;
        if (
          event.event === "init" &&
          typeof event.conversation_id === "string" &&
          !settled
        ) {
          this.activeConversationId = event.conversation_id;
          this.initInfo = (event.init as Record<string, unknown>) || {};
          this.ready = true;
          if (this.outputPaused) stdout.pause();
          settled = true;
          clearTimeout(timer);
          this.pendingInitReject = undefined;
          this.log(`process ready generation=${generation}`);
          resolve(event.conversation_id);
          return;
        }
        if (!this.ready) return;
        if (event.event === "step_update" && validStep(event.step_update)) {
          this.emit("step_update", event.step_update, generation, Date.now());
        } else if (event.event === "result" && validResult(event.result)) {
          this.emit("result", event.result, generation, Date.now());
        } else if (event.event === "error") {
          this.emit("agy_error", event.error, generation);
        } else this.emit("custom_event", event.event, generation);
      });
      const stderrData = (chunk: Buffer) => {
        if (!live()) return;
        stderrSummary.append(chunk);
        this.emit("stderr", chunk.length);
      };
      child.stderr!.on("data", stderrData);
      // stdin can emit EPIPE separately from the write callback.
      child.stdin!.on("error", (error) => {
        if (live()) this.emit("error", error, generation);
      });
      child.once("error", (error) => {
        if (!live()) return;
        this.ready = false;
        fail(error);
        this.emit("error", error, generation);
      });
      child.once("close", (code, signal) => {
        stdout.close();
        if (this.outputReader === stdout) this.outputReader = undefined;
        child.stderr!.off("data", stderrData);
        clearTimeout(timer);
        if (!live()) return;
        this.signal(child, "SIGKILL");
        this.childProcess = null;
        this.ready = false;
        const group = child.pid;
        if (group && process.platform !== "win32") this.unconfirmedGroup = group;
        void (async () => {
          const confirmed = !group || process.platform === "win32" || await waitForProcessGroupExit(group);
          if (confirmed && this.unconfirmedGroup === group) this.unconfirmedGroup = undefined;
          if (generation !== this.generation) return;
          const error = confirmed ? new Error(`Agy CLI exited before initialization (${code ?? signal})`) : new ProcessExitUnconfirmedError();
          fail(error);
          if (!confirmed) this.emit("error", error, generation);
          this.emit("exit", {code, signal, generation, exitConfirmed: confirmed} satisfies AgyExitInfo);
        })().catch(() => {
          if (generation !== this.generation) return;
          const error = new ProcessExitUnconfirmedError();fail(error);this.emit("error", error, generation);
          this.emit("exit", {code, signal, generation, exitConfirmed: false} satisfies AgyExitInfo);
        });
      });
    });
  }

  sendMessage(text: string): Promise<void> {
    const child = this.childProcess;
    if (!this.active || !child?.stdin?.writable || child.stdin.destroyed)
      return Promise.reject(
        new Error("Antigravity process is not ready for input"),
      );
    const generation = this.generation;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out writing to Antigravity stdin")),
        5000,
      );
      child.stdin!.write(
        JSON.stringify({
          event: "user",
          message: { content: [{ type: "text", text }] },
        }) + "\n",
        "utf8",
        (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else if (generation !== this.generation)
            reject(new OperationCancelledError("Antigravity input was cancelled"));
          else resolve();
        },
      );
    });
  }
  abortCurrentTurn(): Promise<void> {
    return this.stop("SIGINT", 500);
  }
  stop(signal: NodeJS.Signals = "SIGTERM", graceMs = 500): Promise<void> {
    ++this.lifecycle;
    ++this.generation;
    return this.stopChild(signal, graceMs);
  }
  private async stopChild(
    signal: NodeJS.Signals,
    graceMs: number,
  ): Promise<void> {
    this.pendingInitReject?.(
      new OperationCancelledError("Antigravity process initialization was cancelled"),
    );
    this.pendingInitReject = undefined;
    if (this.stopping) await this.stopping;
    if (this.unconfirmedGroup) {
      if (!(await waitForProcessGroupExit(this.unconfirmedGroup))) throw new ProcessExitUnconfirmedError();
      this.unconfirmedGroup = undefined;
    }
    const child = this.childProcess;
    this.childProcess = null;
    this.ready = false;
    this.activeConversationId = null;
    this.outputReader?.close();
    this.outputReader = undefined;
    child?.stdout?.resume();
    if (!child) return;
    this.stopping = new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // A parent can exit while a tool child is still alive.
        this.signal(child, "SIGKILL");
        if (child.pid && process.platform !== "win32") {
          const group = child.pid;
          this.unconfirmedGroup = group;
          void waitForProcessGroupExit(group).then(confirmed => {
            if (!confirmed) {reject(new ProcessExitUnconfirmedError());return;}
            if (this.unconfirmedGroup === group) this.unconfirmedGroup = undefined;
            resolve();
          }, () => reject(new ProcessExitUnconfirmedError()));
        } else resolve();
      };
      const timer = setTimeout(finish, Math.max(0, graceMs));
      child.once("close", finish);
      this.signal(child, signal);
      if (child.exitCode !== null || child.signalCode !== null || graceMs <= 0)
        finish();
    });
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already exited */
    }
  }
  dispose(): void {
    void this.stop();
  }
  private buildArgs(options: AgyProcessOptions): string[] {
    const args = buildCliArguments(options);
    return args;
  }
}

function validStep(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    Number.isInteger(s.step_index) &&
    ["ACTIVE", "DONE", "FAILED"].includes(String(s.state)) &&
    [
      "user_input",
      "agent_response",
      "tool",
      "subagent",
      "checkpoint",
      "system_message",
      "error_message",
    ].includes(String(s.step_type)) &&
    (s.subagent_info === undefined || validSubagentInfo(s.subagent_info)) &&
    (s.text_delta === undefined || typeof s.text_delta === "string") &&
    (s.tool_name === undefined || typeof s.tool_name === "string") &&
    (s.tool_info === undefined ||
      (!!s.tool_info &&
        typeof s.tool_info === "object" &&
        ((s.tool_info as Record<string, unknown>).output === undefined ||
          typeof (s.tool_info as Record<string, unknown>).output === "string")))
  );
}
function validResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    ["SUCCESS", "ERROR"].includes(String(r.status)) &&
    (r.response === undefined || typeof r.response === "string") &&
    (r.denied_actions === undefined ||
      (Array.isArray(r.denied_actions) &&
        r.denied_actions.every(
          (d) => d && typeof d === "object" && typeof d.action === "string",
        )))
  );
}

function validSubagentInfo(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const agents = (value as { subagents?: unknown }).subagents;
  return (
    Array.isArray(agents) &&
    agents.length <= 1000 &&
    agents.every((a) => {
      if (!a || typeof a !== "object") return false;
      return (
        ["type_name", "role", "conversation_id", "log_uri"].every(
          (k) => a[k] === undefined || typeof a[k] === "string",
        ) &&
        (a.workspace_uris === undefined ||
          (Array.isArray(a.workspace_uris) &&
            a.workspace_uris.every((v: unknown) => typeof v === "string")))
      );
    })
  );
}
