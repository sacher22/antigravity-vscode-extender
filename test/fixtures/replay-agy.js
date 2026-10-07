#!/usr/bin/env node
if (process.argv[2] === "--version") {console.log("1.2.14"); process.exit(0);}
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const fixture = process.argv.includes("agents-native")
  ? "agents-native-probe.json"
  : process.argv.includes("safe-tool")
    ? "protocol-safe-tool.json"
    : "protocol-plan.json";
const events = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../diagnostics", fixture), "utf8"),
);
const write = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const init = events.find((e) => e.event === "init");
init.conversation_id = "replay-conversation";
init.init.cwd = process.cwd();
write(init);
readline.createInterface({ input: process.stdin }).on("line", () => {
  for (const event of events.filter((e) => e.event !== "init")) {
    if (event.step_update?.conversation_id)
      event.step_update.conversation_id = init.conversation_id;
    if (event.result?.conversation_id)
      event.result.conversation_id = init.conversation_id;
    write(event);
  }
});
