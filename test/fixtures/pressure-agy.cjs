#!/usr/bin/env node
if (process.argv[2] === "--version") {console.log("1.2.14"); process.exit(0);}
// Real pipes and drain-aware generation; all files live in the caller's test cwd.
const fs = require("node:fs");
const readline = require("node:readline");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const event = (value) => JSON.stringify(value) + "\n";
const id = "pressure-" + randomUUID();
process.stdout.write(
  event({ event: "init", conversation_id: id, init: { cwd: process.cwd() } }),
);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content[0].text;
  void generate(text).catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
});
async function generate(text) {
  if (text === "hang-burst") {
    const tool = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});require("fs").writeFileSync("tool.ready","ready");setInterval(()=>{},1000)',
      ],
      { stdio: "ignore" },
    );
    fs.writeFileSync("tool.pid", String(tool.pid));
  }
  const count = text === "stress" ? 2000 : 300;
  for (let i = 0; i < count; i++) {
    const output = ("工具原文🙂" + i + ":").repeat(4000);
    const writable = process.stdout.write(
      event({
        event: "step_update",
        step_update: {
          step_index: i + 1,
          step_type: "tool",
          tool_name: "probe",
          state: "DONE",
          tool_info: { output },
        },
      }),
    );
    fs.writeFileSync(
      "progress.json.tmp",
      JSON.stringify({
        pid: process.pid,
        written: i + 1,
        waitingDrain: !writable,
      }),
    );
    fs.renameSync("progress.json.tmp", "progress.json");
    if (!writable) await once(process.stdout, "drain");
  }
  if (text !== "hang-burst")
    process.stdout.write(
      event({
        event: "result",
        result: { status: "SUCCESS", response: `all ${count} tools delivered` },
      }),
    );
}
