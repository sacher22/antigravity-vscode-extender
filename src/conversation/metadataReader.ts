import { parentPort, workerData } from "worker_threads";
import * as fs from "fs";
import * as path from "path";

// Short-lived startup worker: blocking filesystem calls stay off Extension Host.
// Batches bound structured-clone work; this thread never starts a CLI/model.
if (parentPort) {
  const { root, names } = workerData as { root: string; names: string[] };
  let batch: Array<{
    directory: string;
    meta?: unknown;
    error?: string;
    code?: string;
  }> = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length)
      parentPort!.postMessage({ kind: "batch", entries: batch });
    batch = [];
    bytes = 0;
  };
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name))
      throw new Error("Invalid metadata directory");
    const directory = path.join(root, name);
    try {
      if (fs.statSync(path.join(directory, "session.json")).size > 8 * 1024 * 1024) throw new Error("Conversation metadata exceeds 8 MiB; original retained");
      const raw = fs.readFileSync(path.join(directory, "session.json"), "utf8");
      if (batch.length >= 32 || bytes + raw.length * 2 > 524288) flush();
      batch.push({ directory, meta: JSON.parse(raw) });
      bytes += raw.length * 2;
    } catch (error) {
      batch.push({
        directory,
        error: String(error),
        code: (error as NodeJS.ErrnoException).code,
      });
    }
  }
  flush();
  parentPort.postMessage({ kind: "done" });
}
