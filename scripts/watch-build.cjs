const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
let child,
  timer,
  running = false,
  dirty = false,
  stopping = false;
function run(script, args = []) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      child = undefined;
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`));
    });
  });
}
async function build() {
  if (running || stopping) {
    dirty = true;
    return;
  }
  running = true;
  dirty = false;
  try {
    await run(path.join(__dirname, "clean-build.js"));
    await run(require.resolve("typescript/bin/tsc"), ["-p", root]);
    await run(path.join(__dirname, "build-webview.js"));
    console.log("Host, Webview and Schema build updated.");
  } catch (e) {
    console.error(e.message);
  } finally {
    running = false;
    if (dirty && !stopping) void build();
  }
}
function schedule() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => void build(), 100);
}
const watchers = [
  fs.watch(path.join(root, "src"), { recursive: true }, schedule),
  fs.watch(path.join(root, "tsconfig.json"), schedule),
  fs.watch(path.join(__dirname, "build-webview.js"), schedule),
];
function stop() {
  stopping = true;
  clearTimeout(timer);
  watchers.forEach((w) => w.close());
  child?.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
void build();
