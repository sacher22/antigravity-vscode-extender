#!/usr/bin/env node
if (process.argv[2] === "--version") {console.log("1.2.14"); process.exit(0);}
const readline = require("readline");
if (
  ["models", "agents", "changelog", "mcp", "plugin"].includes(process.argv[2])
) {
  const outputs = {
    models:
      "gemini-3.8-flash-high\tFlash High\ngemini-3.6-flash-low\tFlash Low\ncustom-model\tCustom Model\n",
    agents: "research-agent\n",
    changelog: "FAKE_CHANGELOG",
    mcp: "No MCP servers",
    plugin: "No imported plugins",
  };
  process.stdout.write(outputs[process.argv[2]]);
  process.exit(0);
}

const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const conversationId = process.argv.includes("--conversation")
  ? process.argv[process.argv.indexOf("--conversation") + 1]
  : "fake-" + require("crypto").randomUUID();
const initDelay = process.argv.includes("slow-init") ? 1000 : 5;
process.stdout.write('{"event":"in');
setTimeout(() => {
  process.stdout.write(
    'it","conversation_id":' +
      JSON.stringify(conversationId) +
      ',"init":' +
      JSON.stringify({
        cwd:
          conversationId === "legacy-cwd-mismatch"
            ? "/another-project"
            : process.cwd(),
        agent: process.argv.includes("--agent")
          ? process.argv[process.argv.indexOf("--agent") + 1]
          : undefined,
        model: process.argv[process.argv.indexOf("--model") + 1],
        permission_mode: process.argv.includes("--dangerously-skip-permissions")
          ? "auto"
          : "request-review",
      }) +
      "}\n",
  );
}, initDelay);

readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    const payload = JSON.parse(line);
    const text = payload.message.content[0].text;
    if (text === "result-only") {
      write({event: "result", result: {status: "SUCCESS", response: "result without streamed steps"}});
      return;
    }
    if (text.startsWith("执行要求：")) {
      if (text.includes("VIOLATE_SINGLE_AGENT")) {
        write({
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "tool",
            tool_name: "run_command",
            state: "ACTIVE",
            tool_info: { parameters: { CommandLine: "echo single-agent" } },
          },
        });
        return;
      }
      if (!text.includes("NO_AGENT_EVENTS")) {
        const items = text.includes("ONLY_ONE_AGENT")
          ? ["alpha-child"]
          : ["alpha-child", "beta-child"];
        for (let i = 0; i < 2; i++)
          write({
            event: "step_update",
            step_update: {
              step_index: 2,
              step_type: "subagent",
              tool_name: "invoke_subagent",
              state: "DONE",
              subagent_info: {
                subagents: items.map((id) => ({
                  conversation_id: id,
                  role: id,
                  type_name: "research",
                })),
              },
            },
          });
      }
      write({
        event: "step_update",
        step_update: {
          step_index: 3,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "并行执行结果",
        },
      });
      write({
        event: "result",
        result: { status: "SUCCESS", response: "并行执行结果" },
      });
      return;
    }
    if (text.includes("PLAN_READ_DENIED") && !text.startsWith("读取已被")) {
      write({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          tool_name: "list_dir",
          state: "DONE",
          tool_info: {
            parameters: {
              DirectoryPath: require("path").dirname(process.cwd()),
            },
          },
        },
      });
      write({
        event: "result",
        result: {
          status: "ERROR",
          response: "",
          denied_actions: [{ action: "read_file", display_name: "ListDir" }],
        },
      });
      return;
    }
    if (text.startsWith("读取已被")) {
      if (text.includes("DENY_AGAIN")) {
        write({
          event: "result",
          result: {
            status: "ERROR",
            response: "",
            denied_actions: [{ action: "read_file", display_name: "ListDir" }],
          },
        });
      } else {
        write({
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta:
              "方案：依据已有信息设计动画，外部目录未读取。等待批准。",
          },
        });
        write({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "方案：依据已有信息设计动画，外部目录未读取。等待批准。",
          },
        });
      }
      return;
    }
    if (text === "crash") {
      process.exit(17);
      return;
    }
    if (text === "hang") {
      const child = require("child_process").spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      write({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "child:" + child.pid,
        },
      });
      return;
    }
    process.stdout.write("diagnostic noise\n");
    write({
      event: "step_update",
      step_update: { step_index: 0, step_type: "user_input", state: "DONE" },
    });
    write({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: text,
      },
    });
    write({
      event: "result",
      result: { status: "SUCCESS", response: text, duration_seconds: 0.01 },
    });
  });

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
