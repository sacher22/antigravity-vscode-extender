import { spawn } from "child_process";

/** Bounded capture drains stdout; large diffs do not overflow execFile buffers. */
export function gitChanges(
  root: string,
  diff = false,
  limit = 65536,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      diff
        ? ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
        : ["--no-pager", "status", "--short"],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      total = 0,
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (bytes < limit) {
        const part = chunk.subarray(0, limit - bytes);
        chunks.push(part);
        bytes += part.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192)
        stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 Git：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("读取 Git 状态超时（5 秒）。"));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Git 返回错误（${code}）：${stderr.trim() || "未提供说明"}`,
          ),
        );
        return;
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks), {
        stream: total > bytes,
      });
      resolve(
        (text || "没有 Git 改动。") +
          (total > bytes
            ? "\n[输出已截断为 64 KiB；完整差异请在 VS Code Git 视图查看。]"
            : ""),
      );
    });
  });
}
