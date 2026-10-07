import * as fs from "fs";

/** Stop-time verification only; no discovery timer or signals to unrelated processes. */
export async function processGroupExited(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // Zombies have exited but can retain the group until init reaps them.
  // Inspect numeric /proc entries only if the group still exists.
  const entries = await fs.promises.readdir("/proc");
  let uncertain = false;
  for (let i = 0; i < entries.length; i += 32) {
    const batch = entries.slice(i, i + 32).filter((name) => /^\d+$/.test(name));
    const states = await Promise.all(
      batch.map(async (pid) => {
        try {
          const raw = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
          const fields = raw
            .slice(raw.lastIndexOf(")") + 2)
            .trim()
            .split(" ");
          return Number(fields[2]) === group &&
            fields[0] !== "Z" &&
            fields[0] !== "X"
            ? "live"
            : "other";
        } catch (error) {
          return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")
            ? "other"
            : "unknown";
        }
      }),
    );
    if (states.includes("live")) return false;
    if (states.includes("unknown")) uncertain = true;
  }
  return !uncertain;
}
export async function waitForProcessGroupExit(
  group: number,
  timeoutMs = 250,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await processGroupExited(group)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  return false;
}
