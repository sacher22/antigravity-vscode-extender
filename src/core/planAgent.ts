import * as fs from "fs";
import * as path from "path";
import * as os from "os";
export const PLAN_AGENT = "agy-extender-plan-readonly";
export const PLAN_TOOLS = new Set([
  "view_file",
  "list_dir",
  "grep_search",
  "find_by_name",
]);
const definition = `---
name: ${PLAN_AGENT}
description: Read-only planning for the Antigravity Extender sidebar. Never implement before user approval.
mainAgent: true
subagent: false
tools:
  - view_file
  - list_dir
  - grep_search
  - find_by_name
model: inherit
commandExecutionPolicy: off
---
You produce a plan in the chat response and then stop. You may inspect files using the available read-only tools. Never write files, execute commands, invoke other agents, or implement the plan. Explain missing information in the plan. The user must explicitly approve implementation in a separate turn.
`;
export function ensurePlanAgent(
  home = os.homedir(),
  workspaces: string[] = [],
): string {
  for (const root of workspaces)
    for (const relative of [
      `.agents/agents/${PLAN_AGENT}.md`,
      `.agents/agents/${PLAN_AGENT}/agent.md`,
    ]) {
      if (fs.existsSync(path.join(root, relative)))
        throw new Error(
          "工作区存在同名 Plan Agent，可能覆盖只读配置；已阻止运行。",
        );
    }
  const dir = path.join(home, ".gemini", "config", "agents", PLAN_AGENT);
  const file = path.join(dir, "agent.md");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== definition)
      throw new Error(
        "只读 Plan Agent 配置已变化，请恢复受限配置后再运行 Plan。",
      );
  } else fs.writeFileSync(file, definition, { flag: "wx", mode: 0o600 });
  return PLAN_AGENT;
}
