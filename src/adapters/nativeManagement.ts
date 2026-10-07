import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BinaryResolver } from "../core/binaryResolver";
import { cliCapabilities, requireVerifiedCli, UnverifiedCliError } from "../core/cliCapabilities";
import { PayloadCache } from "../core/payloadCache";
const exec = promisify(execFile);
export class NativeManagementAdapter {
  private cache = new PayloadCache<{ at: number; value: string }>(
    64,
    2 * 1024 * 1024,
    (entry) => entry.value.length * 2 + 8,
  );
  private cacheEpoch = 0;
  private pending = new Map<string, Promise<string>>();
  private skillCache = new PayloadCache<
    Array<{ name: string; origin: string }>
  >(32, 4 * 1024 * 1024, (entries) =>
    entries.reduce(
      (bytes, entry) => bytes + (entry.name.length + entry.origin.length) * 2,
      0,
    ),
  );
  get cacheStats() {
    return {
      queries: this.cache.stats,
      skills: this.skillCache.stats,
      pending: this.pending.size,
    };
  }
  async run(
    cliPath: string | undefined,
    cwd: string,
    args: string[],
    cached = false,
  ): Promise<string> {
    const allowed = [
      "models",
      "agents",
      "changelog",
      "mcp",
      "plugin",
      "--version",
    ];
    if (!allowed.includes(args[0])) throw new Error("不支持的原生管理命令。");
    const cli = await BinaryResolver.resolveCliPath(cliPath);
    const realPath = await fs.promises.realpath(cli);
    const identity = await fs.promises.stat(realPath);
    const epoch = this.cacheEpoch;
    const key = JSON.stringify([
      realPath,
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeMs,
      identity.ctimeMs,
      cwd,
      args,
      epoch,
    ]);
    const found = this.cache.get(key);
    if (cached && found && performance.now() - found.at < 60_000) return found.value;
    const running = this.pending.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        if (["mcp", "plugin"].includes(args[0]) && args[1] && !["list", "help", "status"].includes(args[1]))
          requireVerifiedCli(await cliCapabilities.discover(cli, cwd));
        const { stdout } = await exec(cli, args, {
          cwd,
          timeout: 20_000,
          maxBuffer: 512 * 1024,
          env: { ...process.env, NO_COLOR: "1" },
        });
        const value = redact(stdout).slice(0, 64000).trim() || "操作完成。";
        if (cached && epoch === this.cacheEpoch)
          this.cache.set(key, { at: performance.now(), value });
        return value;
      } catch (error) {
        if (error instanceof UnverifiedCliError) throw new Error("原生管理操作失败：" + error.message);
        throw new Error(
          "原生管理操作失败或超时，请在 CLI 终端检查；敏感参数与输出未写入日志。",
        );
      }
    })().finally(() => {
      // A failed management operation may already have changed CLI configuration.
      if (!cached) this.clear();
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }
  clear() {
    ++this.cacheEpoch;
    cliCapabilities.clear();
    this.cache.clear();
    this.skillCache.clear();
  }
  skills(cwd: string): Array<{ name: string; origin: string }> {
    const cached = this.skillCache.get(cwd);
    if (cached) return cached;
    const roots = [path.join(os.homedir(), ".gemini/config/skills")];
    let current = cwd;
    for (let i = 0; i < 32; i++) {
      for (const folder of [".agents", ".agent", "_agents", "_agent"])
        roots.unshift(path.join(current, folder, "skills"));
      if (
        fs.existsSync(path.join(current, ".git")) ||
        path.dirname(current) === current
      )
        break;
      current = path.dirname(current);
    }
    const found = new Map<string, string>();
    // Only discover names. Native CLI remains responsible for loading and precedence.
    for (const root of roots) {
      try {
        for (const entry of fs
          .readdirSync(root, { withFileTypes: true })
          .slice(0, 1000)) {
          if (
            entry.isDirectory() &&
            /^[a-z][a-z\d-]*$/.test(entry.name) &&
            fs.existsSync(path.join(root, entry.name, "SKILL.md"))
          )
            found.set(entry.name, root);
        }
      } catch {
        /* No customization directory. */
      }
    }
    const skills = Array.from(found, ([name, origin]) => ({ name, origin }));
    this.skillCache.set(cwd, skills);
    return skills;
  }
}
export function redact(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) =>
      /(?:api.?key|secret|password|authorization|bearer|\benv\b|token)\s*[=:]|(?:https?:\/\/)[^\s/]+:[^\s/]+@/i.test(
        line,
      )
        ? "[敏感配置已隐藏]"
        : line,
    )
    .join("\n");
}
