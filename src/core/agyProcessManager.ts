import { ChildProcess, spawn } from "child_process";
import * as readline from "readline";
import { EventEmitter } from "events";
import { AgyIncomingEvent, StepUpdatePayload } from "./types";

export interface AgyProcessOptions {
  cliPath: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkipPermissions?: boolean;
  isPlanMode?: boolean;
  conversationId?: string;
  createProject?: boolean;
  additionalDirectories?: string[];
}

export interface AgyExitInfo {
  code: number | null;
  signal: string | null;
  generation: number;
}

const INIT_TIMEOUT_MS = 30_000;

export class AgyProcessManager extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private isRunning = false;
  private conversationId: string | null = null;
  private generation = 0;
  private pendingInitReject: ((error: Error) => void) | null = null;

  constructor(private readonly log: (message: string) => void = () => undefined) {
    super();
  }

  public get active(): boolean {
    return this.isRunning && this.childProcess !== null;
  }

  public get activeConversationId(): string | null {
    return this.conversationId;
  }

  public async start(options: AgyProcessOptions): Promise<string> {
    await this.stop("SIGTERM", 1_000);
    const generation = ++this.generation;
    const args = this.buildArgs(options);
    this.log(`process start generation=${generation} command=${options.cliPath} args=${args.join(" ")}`);

    const child = spawn(options.cliPath, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.childProcess = child;
    this.isRunning = true;

    if (!child.stdout || !child.stdin || !child.stderr) {
      await this.stop("SIGKILL", 0);
      throw new Error("Failed to initialize stdin/stdout/stderr pipes for agy process");
    }

    const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

    return new Promise<string>((resolve, reject) => {
      let initialized = false;
      const settleInitError = (error: Error) => {
        if (initialized) return;
        initialized = true;
        clearTimeout(initTimer);
        this.pendingInitReject = null;
        reject(error);
      };
      this.pendingInitReject = settleInitError;

      const initTimer = setTimeout(async () => {
        if (generation !== this.generation || initialized) return;
        await this.stop("SIGTERM", 1_000);
        settleInitError(new Error(`Timed out after ${INIT_TIMEOUT_MS / 1000}s waiting for Antigravity init`));
      }, INIT_TIMEOUT_MS);

      rlOut.on("line", (line: string) => {
        if (generation !== this.generation) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        let eventData: AgyIncomingEvent;
        try {
          eventData = JSON.parse(trimmed) as AgyIncomingEvent;
        } catch {
          this.log(`non-json stdout generation=${generation} bytes=${Buffer.byteLength(trimmed)}`);
          this.emit("raw_output", trimmed);
          return;
        }

        const stepUpdate = eventData.event === "step_update" && "step_update" in eventData
          ? eventData.step_update as StepUpdatePayload
          : undefined;
        const isTextDelta = stepUpdate?.step_type === "agent_response" && stepUpdate.state === "ACTIVE";
        if (!isTextDelta) this.log(`event generation=${generation} type=${eventData.event}`);
        this.handleEvent(eventData);
        if (eventData.event === "init" && !initialized && "conversation_id" in eventData && typeof eventData.conversation_id === "string") {
          initialized = true;
          clearTimeout(initTimer);
          this.pendingInitReject = null;
          this.conversationId = eventData.conversation_id;
          this.log(`process ready generation=${generation} pid=${child.pid ?? "unknown"}`);
          resolve(eventData.conversation_id);
        }
      });

      rlErr.on("line", (line: string) => {
        if (generation !== this.generation) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        this.log(`stderr generation=${generation} bytes=${Buffer.byteLength(trimmed)}`);
        this.emit("stderr", trimmed);
      });

      child.once("error", (error: Error) => {
        if (generation !== this.generation) return;
        this.isRunning = false;
        this.log(`process error generation=${generation} message=${error.message}`);
        settleInitError(error);
        this.emit("error", error);
      });

      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (generation !== this.generation) return;
        clearTimeout(initTimer);
        this.isRunning = false;
        this.childProcess = null;
        this.log(`process close generation=${generation} code=${code} signal=${signal ?? "none"}`);
        settleInitError(new Error(`Agy CLI exited with code ${code} (signal: ${signal}) before initialization`));
        this.emit("exit", { code, signal, generation } satisfies AgyExitInfo);
      });
    });
  }

  public sendMessage(promptText: string): Promise<void> {
    const child = this.childProcess;
    if (!child?.stdin || !this.isRunning || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error("Antigravity process is not ready for input"));
    }

    const payload = JSON.stringify({
      event: "user",
      message: { content: [{ type: "text", text: promptText }] },
    }) + "\n";

    this.log(`stdin write generation=${this.generation} bytes=${Buffer.byteLength(payload)}`);
    return new Promise<void>((resolve, reject) => {
      child.stdin!.write(payload, "utf8", (error?: Error | null) => {
        if (error) {
          this.log(`stdin error generation=${this.generation} message=${error.message}`);
          reject(error);
          return;
        }
        this.log(`stdin flushed generation=${this.generation}`);
        resolve();
      });
    });
  }

  public async abortCurrentTurn(): Promise<void> {
    await this.stop("SIGINT", 2_000);
  }

  public async stop(initialSignal: NodeJS.Signals = "SIGTERM", graceMs = 1_000): Promise<void> {
    const child = this.childProcess;
    const rejectPendingInit = this.pendingInitReject;
    this.pendingInitReject = null;
    rejectPendingInit?.(new Error("Antigravity process initialization was cancelled"));
    if (!child) {
      this.isRunning = false;
      this.conversationId = null;
      return;
    }

    ++this.generation;
    this.childProcess = null;
    this.isRunning = false;
    this.conversationId = null;
    this.log(`process stop pid=${child.pid ?? "unknown"} signal=${initialSignal}`);
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      child.once("close", finish);
      try {
        child.kill(initialSignal);
      } catch {
        finish();
        return;
      }
      if (graceMs <= 0) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
        return;
      }
      termTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }, graceMs);
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
      }, graceMs + 2_000);
    });
  }

  public dispose(): void {
    void this.stop("SIGTERM", 500);
    this.removeAllListeners();
  }

  private buildArgs(options: AgyProcessOptions): string[] {
    const args = ["--output-format", "stream-json", "--input-format", "stream-json"];
    if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (options.model) args.push("--model", options.model);
    if (options.effort && (!options.model || !/-(low|medium|high)$/.test(options.model))) {
      args.push("--effort", options.effort);
    }
    if (options.isPlanMode) args.push("--mode", "plan");
    if (options.createProject) args.push("--new-project");
    for (const directory of options.additionalDirectories || []) {
      args.push("--add-dir", directory);
    }
    if (options.conversationId) args.push("--conversation", options.conversationId);
    return args;
  }

  private handleEvent(eventData: AgyIncomingEvent): void {
    switch (eventData.event) {
      case "init":
        if ("conversation_id" in eventData && typeof eventData.conversation_id === "string") {
          this.conversationId = eventData.conversation_id;
          this.emit("init", eventData.conversation_id, eventData.init);
        }
        break;
      case "step_update":
        if ("step_update" in eventData) this.emit("step_update", eventData.step_update);
        break;
      case "result":
        if ("result" in eventData) this.emit("result", eventData.result);
        break;
      case "error":
        if ("error" in eventData) this.emit("agy_error", eventData.error);
        break;
      default:
        this.emit("custom_event", eventData);
    }
  }
}
