import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

interface Owner {
  formatVersion?: 2;
  pid: number;
  token: string;
  identity?: string;
  execution?: {state: "pending" | "bound"; pid?: number; identity?: string; group?: number};
}
export type ExecutionLease = (() => void) & {
  markExecutionPending(): void;
  bindProcess(pid: number): void;
};
function identity(pid: number): string | undefined {
  if (process.platform !== "linux") return;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^\d+$/.test(start)) throw new Error("无法核对执行锁进程身份。");
    return (
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
      ":" +
      start
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function ownerAt(lock: string): Owner {
  const owner = JSON.parse(
    fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
  );
  if (
    (owner.formatVersion !== undefined && owner.formatVersion !== 2) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(owner.token) ||
    (owner.identity !== undefined && typeof owner.identity !== "string")
  )
    throw new Error("执行锁损坏，已保留原锁，请检查存储目录。");
  if (owner.execution && (!['pending', 'bound'].includes(owner.execution.state) ||
      (owner.execution.state === 'bound' && (!Number.isSafeInteger(owner.execution.pid) || owner.execution.pid! <= 0 ||
       (owner.execution.identity !== undefined && typeof owner.execution.identity !== 'string') ||
       (owner.execution.group !== undefined && (!Number.isSafeInteger(owner.execution.group) || owner.execution.group <= 0))))))
    throw new Error("执行锁进程记录损坏，已保留原锁。");
  return owner;
}
function executionStillOwned(owner: Owner): boolean {
  const execution = owner.execution;
  if (!execution) return false;
  const boot = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : undefined;
  if (boot && owner.identity && !owner.identity.startsWith(boot + ":")) return false;
  // A crash between publishing intent and binding a PID cannot prove no spawn occurred.
  if (execution.state === "pending") return true;
  let zombie = false;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${execution.pid}/stat`, "utf8");
      zombie = ["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[0]);
    } catch(error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    }
  }
  if (!zombie && alive({pid: execution.pid!, token: owner.token, identity: execution.identity})) return true;
  // A missing independent group cannot prove tool descendants have exited.
  if (!execution.group || process.platform !== "linux") return true;
  if (execution.identity && !execution.identity.startsWith(boot + ":")) return false;
  try {process.kill(-execution.group, 0);} catch(error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  // Recovery only: a dead group leader can leave living tool children.
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
      if (Number(fields[2]) === execution.group && !["Z", "X"].includes(fields[0])) return true;
    } catch(error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    }
  }
  return false;
}
function alive(owner: Owner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  return !owner.identity || owner.identity === identity(owner.pid);
}
/** Populated directories make owner-specific stale renames non-overwriting. */
export function acquireExecutionLease(lock: string): ExecutionLease {
  const token = randomUUID();
  const candidate = lock + ".candidate-" + token;
  const owner: Owner = {
    formatVersion: 2,
    pid: process.pid,
    token,
    identity: identity(process.pid),
  };
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(candidate, "owner.json"),
      JSON.stringify(owner),
      { mode: 0o600 },
    );
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.renameSync(candidate, lock);
        let released = false;
        let retired: string | undefined;
        const release = () => {
          if (released) return;
          if (!retired) {
            let current: Owner;
            try {current = ownerAt(lock);} catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {released = true;return;}
              throw error;
            }
            if (current.token !== token) {released = true;return;}
            // Retire only this owner. A cleanup retry never targets the live lock
            // path, which may already belong to a subsequently published owner.
            const target = lock + ".released-" + token;
            fs.renameSync(lock, target);
            retired = target;
          }
          fs.rmSync(retired, {recursive: true, force: true});
          released = true;
        };
        const update = (execution: NonNullable<Owner["execution"]>) => {
          if (released || ownerAt(lock).token !== token) throw new Error("执行锁属主已变更，不能绑定进程。");
          const temporary = path.join(lock, "owner-" + randomUUID() + ".tmp");
          try {
            fs.writeFileSync(temporary, JSON.stringify({...owner, execution}), {mode: 0o600, flag: "wx"});
            fs.renameSync(temporary, path.join(lock, "owner.json"));
            owner.execution = execution;
          } finally {fs.rmSync(temporary, {force: true});}
        };
        return Object.assign(release, {
          markExecutionPending: () => update({state: "pending"}),
          bindProcess: (pid: number) => {
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("CLI 进程ID无效。");
            const processIdentity = identity(pid);
            if (process.platform === "linux" && !processIdentity) throw new Error("CLI 已退出，无法绑定进程身份。");
            let group: number | undefined;
            if (process.platform === "linux") {
              const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
              group = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[2]);
              // Only our detached CLI groups are tracked as groups. Native shells
              // can share a group with unrelated terminal processes.
              if (group !== pid) group = undefined;
            }
            update({state: "bound", pid, identity: processIdentity, group});
          },
        });
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      }
      try {
        if (!fs.lstatSync(lock).isDirectory()) {
          // Older hosts use unlink/recreate. A check followed by unlink/rename
          // cannot safely reclaim their files while they may still be running.
          throw new Error(
            "该会话存在旧版执行锁；请在旧窗口任务结束后重试，失效文件锁需离线核对后归档。",
          );
        }
        const prior = ownerAt(lock);
        if (alive(prior))
          throw new Error("该会话正在另一个 VS Code 窗口执行。");
        if (prior.formatVersion !== 2) {
          const boot = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : undefined;
          if (!boot || !prior.identity || prior.identity.startsWith(boot + ":"))
            throw new Error("旧版执行锁没有CLI归属记录，无法确认遗留任务已退出；请离线核对后归档原锁。");
        }
        if (executionStillOwned(prior))
          throw new Error("旧宿主已退出，但CLI或工具进程仍存活，或启动归属未确认；已保留执行锁，请先核对原任务。");
        try {
          fs.renameSync(lock, lock + ".retired-" + prior.token);
        } catch (error) {
          if (
            !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code || "",
            )
          )
            throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("执行锁正在变更，请重试。");
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}
