import * as fs from "fs";
import { spawn } from "child_process";
import { BinaryResolver } from "./binaryResolver";
import {
  OperationCancelledError,
  ProbeExitUnconfirmedError,
} from "./operationErrors";
import { waitForProcessGroupExit } from "./processGroup";
import { PayloadCache } from "./payloadCache";

export interface CliCapabilities {
  cliPath: string;
  version?: string;
  status: "verified" | "unverified" | "unavailable";
  checkedAt: number;
  streamJson: boolean;
  readOnlyPlan: boolean;
  subagents: boolean;
  skills: boolean;
  schema: "experimental" | "unverified";
  sandbox: "launch-only" | "unverified";
  toolApproval: false;
  reason?: "version-query-failed" | "version-not-verified";
}
export function versionCapabilities(
  cliPath: string,
  version: string | undefined,
  checkedAt: number,
): Readonly<CliCapabilities> {
  // Exact versions only. 1.2.16 captures and owned-process checks are in
  // diagnostics/protocol-1.2.16-first and test/fixtures/cli-1.2.16-captured.json.
  // Launch-only sandbox/experimental schema do not promise OS isolation or valid model output.
  const verified = version === "1.2.14" || version === "1.2.16";
  return Object.freeze({
    cliPath,
    version,
    checkedAt,
    status: verified ? "verified" : version ? "unverified" : "unavailable",
    streamJson: verified,
    readOnlyPlan: verified,
    subagents: verified,
    skills: verified,
    schema: verified ? "experimental" : "unverified",
    sandbox: verified ? "launch-only" : "unverified",
    toolApproval: false,
    ...(verified
      ? {}
      : {
          reason: version
            ? ("version-not-verified" as const)
            : ("version-query-failed" as const),
        }),
  });
}
/** Read-only, bounded version probe. No models, permissions or credential queries. */
async function queryVersion(
  cliPath: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["--version"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    let output = "",
      settled = false,
      exceeded = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      if (!settled && !cleanupTimer)
        cleanupTimer = setTimeout(
          () => finish(undefined, new ProbeExitUnconfirmedError()),
          300,
        );
    };
    const finish = (version?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", terminate);
      if (error) {
        child.stdout?.destroy();
        reject(error);
      } else resolve(version);
    };
    const timer = setTimeout(() => {
      exceeded = true;
      terminate();
    }, 1500);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 8192) {
        exceeded = true;
        terminate();
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish());
    // Version wrappers can leave helpers with ignored stdio after their leader
    // exits. No query-owned helper should outlive this read-only operation.
    child.once("exit", terminate);
    child.once("close", (code) => {
      void (async () => {
        // Do not accept a version buried in arbitrary output (including prompts or secrets).
        const value = output.trim();
        const match =
          /^(?:Antigravity(?: CLI)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][a-zA-Z\d.-]+)?)$/i.exec(
            value,
          );
        if (
          process.platform !== "win32" &&
          child.pid &&
          !(await waitForProcessGroupExit(child.pid))
        ) {
          finish(undefined, new ProbeExitUnconfirmedError());
          return;
        }
        finish(code === 0 && !exceeded ? match?.[1] : undefined);
      })().catch(() => finish(undefined, new ProbeExitUnconfirmedError()));
    });
  });
}
function cancelled(): Error {
  return new OperationCancelledError();
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
interface PendingProbe {
  promise: Promise<Readonly<CliCapabilities>>;
  abort: AbortController;
  consumers: Set<object>;
  settled: boolean;
}
function subscribeProbe(
  probe: PendingProbe,
  signal?: AbortSignal,
): Promise<Readonly<CliCapabilities>> {
  checkSignal(signal);
  const consumer = {};
  probe.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    const detach = () => {
      probe.consumers.delete(consumer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      detach();
      if (!probe.consumers.size && !probe.settled) {
        probe.abort.abort();
        // Last consumer waits until its query process has closed. Other
        // consumers' queries remain live and are not owned by this stop.
        void probe.promise.then(
          () => reject(cancelled()),
          (error) =>
            reject(
              error instanceof ProbeExitUnconfirmedError ? error : cancelled(),
            ),
        );
      } else reject(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
    void probe.promise.then(
      (value) => {
        detach();
        signal?.aborted ? reject(cancelled()) : resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      },
    );
  });
}
export class CliCapabilityCache {
  private readonly cache = new PayloadCache<{
    at: number;
    value: Readonly<CliCapabilities>;
  }>(
    32,
    64 * 1024,
    (entry) =>
      (entry.value.cliPath.length + (entry.value.version?.length || 0)) * 2 +
      264,
  );
  private readonly pending = new Map<string, PendingProbe>();
  private epoch = 0;
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly ttlMs = 60_000,
  ) {}
  get stats() {
    return {
      ...this.cache.stats,
      pending: this.pending.size,
      consumers: Array.from(this.pending.values()).reduce(
        (count, probe) => count + probe.consumers.size,
        0,
      ),
    };
  }
  clear() {
    ++this.epoch;
    this.cache.clear();
  }
  async discover(
    configuredPath: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Readonly<CliCapabilities>> {
    checkSignal(signal);
    const cliPath = await BinaryResolver.resolveCliPath(configuredPath);
    const realPath = await fs.promises.realpath(cliPath);
    const stat = await fs.promises.stat(realPath);
    const epoch = this.epoch;
    const key = JSON.stringify([
      realPath,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      cwd,
      epoch,
    ]);
    checkSignal(signal);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;
    const pending = this.pending.get(key);
    if (pending && !pending.abort.signal.aborted)
      return subscribeProbe(pending, signal);
    const probe: PendingProbe = {
      abort: new AbortController(),
      consumers: new Set(),
      settled: false,
      promise: undefined as unknown as Promise<Readonly<CliCapabilities>>,
    };
    probe.promise = queryVersion(cliPath, cwd, probe.abort.signal)
      .then(async (version) => {
        checkSignal(probe.abort.signal);
        const currentPath = await fs.promises.realpath(cliPath);
        const current = await fs.promises.stat(currentPath);
        const currentKey = JSON.stringify([
          currentPath,
          current.dev,
          current.ino,
          current.size,
          current.mtimeMs,
          current.ctimeMs,
          cwd,
          this.epoch,
        ]);
        // A stale successful probe must not authorize a newly replaced executable.
        checkSignal(probe.abort.signal);
        if (currentKey !== key)
          return this.discover(configuredPath, cwd, probe.abort.signal);
        const value = versionCapabilities(cliPath, version, Date.now());
        if (epoch === this.epoch)
          this.cache.set(key, { at: this.now(), value });
        return value;
      })
      .finally(() => {
        probe.settled = true;
        if (this.pending.get(key) === probe) this.pending.delete(key);
      });
    this.pending.set(key, probe);
    return subscribeProbe(probe, signal);
  }
}
export const cliCapabilities = new CliCapabilityCache();
export class UnverifiedCliError extends Error {}
export function requireVerifiedCli(
  capabilities: Readonly<CliCapabilities>,
): void {
  if (!capabilities.streamJson)
    throw new UnverifiedCliError(
      `CLI ${capabilities.version || "版本未知"} 的侧栏协议未验证，已阻止执行并保留草稿。请使用 /cli 打开原生终端；/capabilities 查看能力，更新或更换 CLI 后可重新探测。`,
    );
}
