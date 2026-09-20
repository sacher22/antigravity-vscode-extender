#!/usr/bin/env node
const readline = require("readline");

const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const initDelay = process.argv.includes("slow-init") ? 1000 : 5;
process.stdout.write('{"event":"in');
setTimeout(() => {
  process.stdout.write('it","conversation_id":"fake-conversation"}\n');
}, initDelay);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const payload = JSON.parse(line);
  const text = payload.message.content[0].text;
  process.stdout.write("diagnostic noise\n");
  write({
    event: "step_update",
    step_update: { step_index: 0, step_type: "user_input", state: "DONE" },
  });
  write({
    event: "step_update",
    step_update: { step_index: 1, step_type: "agent_response", state: "ACTIVE", text_delta: text },
  });
  write({
    event: "result",
    result: { status: "SUCCESS", response: text, duration_seconds: 0.01 },
  });
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
