import { promises as fs } from "fs";
import { randomUUID } from "crypto";

/** Publish only a complete record; cleanup is limited to this call's temp file. */
export async function writeAtomicFile(
  file: string,
  raw: string,
  onCleanupFailure: () => void = () => {},
): Promise<void> {
  const temporary = file + "." + randomUUID() + ".tmp";
  let committed = false;
  let collision = false;
  try {
    try { await fs.writeFile(temporary, raw, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      collision = (error as NodeJS.ErrnoException).code === "EEXIST";
      throw error;
    }
    await fs.rename(temporary, file);
    committed = true;
  } finally {
    if (!committed && !collision) {
      try { await fs.rm(temporary, { force: true }); }
      catch {
        // A secondary cleanup/reporting error must not replace the write error.
        try { onCleanupFailure(); } catch {}
      }
    }
  }
}
