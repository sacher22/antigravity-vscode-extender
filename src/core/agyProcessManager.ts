import { ChildProcess, spawn } from "child_process";
import * as readline from "readline";
import { EventEmitter } from "events";
import { AgyIncomingEvent, StepUpdatePayload, ResultPayload } from "./types";

export interface AgyProcessOptions {
  cliPath: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkipPermissions?: boolean;
  isPlanMode?: boolean;
  conversationId?: string;
}

export class AgyProcessManager extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  private conversationId: string | null = null;

  constructor() {
    super();
  }

  public get active(): boolean {
    return this.isRunning && this.childProcess !== null;
  }

  public get activeConversationId(): string | null {
    return this.conversationId;
  }

  public start(options: AgyProcessOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.childProcess) {
        this.kill();
      }

      const args = [
        "--output-format", "stream-json",
        "--input-format", "stream-json"
      ];

      if (options.dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }

      if (options.model) {
        args.push("--model", options.model);
      }

      // If effort is passed and model is generic (does not already end with -low/-medium/-high), pass --effort
      if (options.effort && options.model && !options.model.endsWith(`-${options.effort}`)) {
        const hasEffortSuffix = ["-low", "-medium", "-high"].some(s => options.model!.endsWith(s));
        if (!hasEffortSuffix) {
          args.push("--effort", options.effort);
        }
      }

      if (options.isPlanMode) {
      args.push("--mode", "plan");
    }
    if (options.conversationId) {
        args.push("--conversation", options.conversationId);
      }

      try {
        this.childProcess = spawn(options.cliPath, args, {
          cwd: options.cwd,
          env: {
            ...process.env,
            NO_COLOR: "1",
            TERM: "dumb"
          },
          stdio: ["pipe", "pipe", "pipe"]
        });

        this.isRunning = true;

        if (!this.childProcess.stdout || !this.childProcess.stdin || !this.childProcess.stderr) {
          throw new Error("Failed to initialize stdin/stdout/stderr pipes for agy process");
        }

        const rlOut = readline.createInterface({
          input: this.childProcess.stdout,
          crlfDelay: Infinity
        });

        const rlErr = readline.createInterface({
          input: this.childProcess.stderr,
          crlfDelay: Infinity
        });

        let initResolved = false;

        rlOut.on("line", (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          try {
            const eventData = JSON.parse(trimmed) as AgyIncomingEvent;
            this.handleEvent(eventData);

            if (eventData.event === "init" && !initResolved) {
              initResolved = true;
              this.conversationId = eventData.conversation_id;
              resolve(eventData.conversation_id);
            }
          } catch (err) {
            this.emit("raw_output", trimmed);
          }
        });

        rlErr.on("line", (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          this.emit("stderr", trimmed);
        });

        this.childProcess.on("error", (err: Error) => {
          this.isRunning = false;
          this.emit("error", err);
          if (!initResolved) {
            initResolved = true;
            reject(err);
          }
        });

        this.childProcess.on("exit", (code: number | null, signal: string | null) => {
          this.isRunning = false;
          this.emit("exit", { code, signal });
          if (!initResolved) {
            initResolved = true;
            reject(new Error(`Agy CLI exited with code ${code} (signal: ${signal}) before initialization`));
          }
        });

        // Timeout fallback for init
        setTimeout(() => {
          if (!initResolved) {
            initResolved = true;
            if (this.childProcess) {
              resolve(options.conversationId || "");
            } else {
              reject(new Error("Timeout waiting for Antigravity init event"));
            }
          }
        }, 8000);

      } catch (err) {
        this.isRunning = false;
        reject(err);
      }
    });
  }

  public sendMessage(promptText: string): boolean {
    if (!this.childProcess || !this.childProcess.stdin || !this.isRunning) {
      return false;
    }

    const payload = {
      event: "user",
      message: {
        content: [
          {
            type: "text",
            text: promptText
          }
        ]
      }
    };

    try {
      this.childProcess.stdin.write(JSON.stringify(payload) + "\n");
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  public abortCurrentTurn(): void {
    if (this.childProcess && this.isRunning) {
      // Send SIGINT to gracefully interrupt model generation / tool execution
      try {
        this.childProcess.kill("SIGINT");
      } catch (err) {
        console.error("Failed to send SIGINT to child process", err);
      }
    }
  }

  public kill(): void {
    if (this.childProcess) {
      try {
        this.childProcess.kill("SIGTERM");
      } catch (err) {
        // ignore
      }
      this.childProcess = null;
    }
    this.isRunning = false;
    this.conversationId = null;
  }

  public dispose(): void {
    this.kill();
    this.removeAllListeners();
  }

  private handleEvent(eventData: AgyIncomingEvent): void {
    switch (eventData.event) {
      case "init":
        this.conversationId = eventData.conversation_id;
        this.emit("init", eventData.conversation_id, eventData.init);
        break;

      case "step_update":
        this.emit("stepUpdate", eventData.step_update);
        break;

      case "result":
        this.emit("result", eventData.result);
        break;

      case "error":
        this.emit("agy_error", eventData.error);
        break;

      default:
        this.emit("custom_event", eventData);
        break;
    }
  }
}
