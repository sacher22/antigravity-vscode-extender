import { promises as fs } from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { SessionMeta, ChatMessage } from "../core/types";
import { Worker } from "worker_threads";
import { writeAtomicFile } from "./atomicFile";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return (
      (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() +
      ":" +
      start
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function migrationLease(root: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    identity: await processIdentity(process.pid),
  };
  const candidate = path.join(root, ".migration-candidate-" + token);
  const lock = path.join(root, ".migration-lock");
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(
    path.join(candidate, "owner.json"),
    JSON.stringify(owner),
    { mode: 0o600 },
  );
  const deadline = Date.now() + 120000;
  try {
    for (;;) {
      try {
        // Publish a populated directory atomically. It cannot replace a
        // populated lease directory held by another initializer.
        await fs.rename(candidate, lock);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          let current;
          try {
            current = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          if (current.token !== token) return;
          const retired = path.join(root, ".migration-released-" + token);
          await fs.rename(lock, retired);
          await fs.rm(retired, { recursive: true, force: true });
        };
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      }
      try {
        const prior = JSON.parse(
          await fs.readFile(path.join(lock, "owner.json"), "utf8"),
        );
        if (
          !Number.isSafeInteger(prior.pid) ||
          prior.pid <= 0 ||
          !/^[a-f0-9-]{36}$/.test(prior.token)
        )
          throw new Error("历史迁移锁损坏，已保留原记录，请检查存储目录。");
        let alive = true;
        try {
          process.kill(prior.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          alive = false;
        }
        if (alive && prior.identity)
          alive = prior.identity === (await processIdentity(prior.pid));
        if (!alive) {
          // Keep a populated, owner-specific stale directory. Another stale
          // observer cannot rename a newly acquired lease over this archive.
          const stale = path.join(root, ".migration-stale-" + prior.token);
          try {
            await fs.rename(lock, stale);
          } catch (error) {
            if (
              !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
                (error as NodeJS.ErrnoException).code || "",
              )
            )
              throw error;
          }
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline)
        throw new Error(
          "另一个窗口仍在迁移历史，请等待完成后重试；没有停止它的任务。",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await fs.rm(candidate, { recursive: true, force: true });
    throw error;
  }
}
async function exists(file: string) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function atomic(file: string, value: unknown, progress: (message: string) => void) {
  await writeAtomicFile(file, JSON.stringify(value), () => progress("未提交的迁移临时记录清理失败；原记录保留，请核对存储目录。"));
}
export async function quarantineAsync(
  root: string,
  file: string,
  error: unknown,
) {
  await fs.mkdir(path.join(root, "quarantine"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(root, "quarantine", hash(file) + ".json"),
    JSON.stringify({ file, reason: String(error) }),
    { mode: 0o600 },
  );
}

/** Migration stages complete sessions before publishing them; legacy originals stay intact. */
export async function initializeStorage(
  root: string,
  storage: string,
  global: SessionMeta[],
  validate: (meta: SessionMeta) => void,
  progress: (message: string) => void = () => {},
): Promise<SessionMeta[]> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, "migration.json");
  const release = !(await exists(marker))
    ? await migrationLease(root)
    : undefined;
  try {
    if (!(await exists(marker))) {
      progress("备份旧会话记录");
      const old = path.join(storage, "sessions-v2");
      const backup = path.join(root, "legacy-backup");
      await fs.mkdir(backup, { recursive: true, mode: 0o700 });
      if (await exists(old))
        await fs.cp(old, path.join(backup, "sessions-v2"), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      if (!(await exists(path.join(backup, "globalState.json"))))
        await atomic(path.join(backup, "globalState.json"), global, progress);
      let sources = global;
      const index = path.join(old, "index.json");
      if (await exists(index)) {
        try {
          sources = JSON.parse(await fs.readFile(index, "utf8"));
          if (!Array.isArray(sources)) throw new Error("Invalid legacy index");
        } catch (error) {
          sources = global;
          await quarantineAsync(root, index, error);
          if (
            (error as NodeJS.ErrnoException).code &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
        }
      }
      let migrated = 0;
      for (const source of sources) {
        progress(`迁移会话 ${++migrated}/${sources.length}`);
        try {
          validate(source);
          const target = path.join(root, hash(source.id));
          // A completed v3 record may have been changed after an interrupted
          // migration. Never overwrite it with the older legacy version.
          if (await exists(path.join(target, "session.json"))) continue;
          let session = source;
          let messages: ChatMessage[] = source.messages || [];
          const directory = path.join(old, hash(source.id));
          const whole = path.join(old, hash(source.id) + ".json");
          if (await exists(whole)) {
            session = JSON.parse(await fs.readFile(whole, "utf8"));
            messages = session.messages;
          } else if (await exists(path.join(directory, "session.json"))) {
            session = JSON.parse(
              await fs.readFile(path.join(directory, "session.json"), "utf8"),
            );
            messages = [];
            for (const file of (
              await fs.readdir(path.join(directory, "messages"))
            )
              .filter((file) => file.endsWith(".json"))
              .sort())
              messages.push(
                JSON.parse(
                  await fs.readFile(
                    path.join(directory, "messages", file),
                    "utf8",
                  ),
                ),
              );
          }
          validate(session);
          if (session.id !== source.id || !Array.isArray(messages))
            throw new Error("Invalid legacy conversation");
          const staging = path.join(
            root,
            ".migration-staging-" + hash(source.id),
          );
          await fs.rm(staging, { recursive: true, force: true });
          await fs.mkdir(path.join(staging, "messages"), {
            recursive: true,
            mode: 0o700,
          });
          for (let index = 0; index < messages.length; index++) {
            const message = { ...messages[index] };
            if (typeof message.content !== "string")
              throw new Error("Invalid legacy message");
            message.id ||= "migrated-" + hash(source.id + ":" + index);
            message.toolCalls ||= message.tools;
            if (message.status === "running") message.status = "interrupted";
            const filename = `${String(index).padStart(10, "0")}-${hash(message.id).slice(0, 16)}.json`;
            await fs.writeFile(
              path.join(staging, "messages", filename),
              JSON.stringify(message),
              { mode: 0o600 },
            );
          }
          const { messages: _, ...meta } = session;
          await atomic(path.join(staging, "session.json"), {
            ...meta,
            cliConversationId:
              session.cliConversationId ||
              (!session.id.startsWith("sess_") ? session.id : undefined),
            messageCount: messages.length,
          }, progress);
          if (await exists(target)) {
            // Preserve incomplete records from previous migrations for recovery.
            const preserved = path.join(
              root,
              "quarantine",
              "incomplete-" + hash(source.id),
            );
            await fs.mkdir(path.dirname(preserved), {
              recursive: true,
              mode: 0o700,
            });
            if (await exists(preserved))
              throw new Error(
                "Incomplete migration requires recovery; original records retained",
              );
            await fs.rename(target, preserved);
          }
          await fs.rename(staging, target);
        } catch (error) {
          await quarantineAsync(root, source?.id || "unknown", error);
          if (
            (error as NodeJS.ErrnoException).code &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
        }
      }
      await atomic(marker, { version: 3, completedAt: Date.now() }, progress);
    }
  } finally {
    await release?.();
  }
  const directories = (await fs.readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
  );
  const sessions: SessionMeta[] = [];
  progress(`读取 ${directories.length} 份会话元数据`);
  if (directories.length >= 500) {
    const errors: Array<{ directory: string; error: string; code?: string }> =
      [];
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "metadataReader.js"), {
        workerData: { root, names: directories.map((entry) => entry.name) },
      });
      let done = false;
      worker.on("message", (message) => {
        if (message.kind === "done") { done = true; return; }
        if (message.kind !== "batch") return;
        for (const entry of message.entries) {
          if (entry.error) {
            errors.push(entry);
            continue;
          }
          try {
            validate(entry.meta);
            if (hash(entry.meta.id) !== path.basename(entry.directory))
              throw new Error(
                "Conversation identity does not match its directory",
              );
            sessions.push({ ...entry.meta, messages: [] });
          } catch (error) {
            errors.push({ directory: entry.directory, error: String(error) });
          }
        }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (!done || code !== 0)
          reject(
            new Error(`Metadata reader exited before completing (${code})`),
          );
        else resolve();
      });
    });
    for (const entry of errors) {
      await quarantineAsync(root, entry.directory, entry.error);
      if (entry.code && entry.code !== "ENOENT") throw new Error(entry.error);
    }
    return sessions;
  }
  // Bounded concurrency avoids flooding a remote/slow filesystem on startup.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, directories.length) }, async () => {
      for (;;) {
        const entry = directories[next++];
        if (!entry) return;
        const directory = path.join(root, entry.name);
        try {
          const meta = JSON.parse(
            await fs.readFile(path.join(directory, "session.json"), "utf8"),
          );
          validate(meta);
          if (hash(meta.id) !== entry.name)
            throw new Error(
              "Conversation identity does not match its directory",
            );
          sessions.push({ ...meta, messages: [] });
        } catch (error) {
          await quarantineAsync(root, directory, error);
          if (
            (error as NodeJS.ErrnoException).code &&
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw error;
        }
      }
    }),
  );
  return sessions;
}
