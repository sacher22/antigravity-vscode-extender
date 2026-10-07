export interface CommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  route: "sidebar" | "native" | "skill";
  busy?: boolean;
  draftPolicy?: "persist" | "memory-only";
  arguments?: CommandArguments;
  effects?: CommandEffect[];
  capability?:
    "local" | "cli-query" | "stream-json" | "native-terminal" | "experimental";
}
export type CommandEffect =
  | "configuration"
  | "model"
  | "history"
  | "execution"
  | "editor"
  | "clipboard"
  | "handoff"
  | "native-management";
export interface CommandArguments {
  min: number;
  max?: number;
  values?: Record<number, string[]>;
  defaultOperation?: string;
  forms?: Array<{
    operation: string;
    min: number;
    max?: number;
    namePattern?: string;
    rejectFlags?: boolean;
  }>;
}
export const commandRegistry: CommandSpec[] = [
  {name: "diagnostics", description: "查看或导出不含正文的宿主等待时间线，clear 清空", usage: "/diagnostics [export|clear]", route: "sidebar", busy: true},
  {name: "capabilities", description: "查看实际 CLI 版本及已验证能力，refresh 重新探测", usage: "/capabilities [refresh]", route: "sidebar", busy: true},
  {
    name: "artifact",
    description: "列出 CLI 会话文件，或在编辑器打开指定文件；review 到原生",
    usage: "/artifact [文件名|review]",
    route: "sidebar",
    busy: true,
  },
  {
    name: "version",
    description: "查看 CLI 版本",
    usage: "/version",
    route: "sidebar",
    busy: true,
  },
  {
    name: "help",
    description: "列出命令、来源和支持状态",
    usage: "/help",
    route: "sidebar",
    busy: true,
  },
  {
    name: "new",
    aliases: ["clear"],
    description: "新建对话，保留其他任务运行",
    usage: "/new",
    route: "sidebar",
    busy: true,
  },
  {
    name: "stop",
    description: "停止当前对话",
    usage: "/stop",
    route: "sidebar",
    busy: true,
  },
  {
    name: "history",
    description: "列出或切换历史对话",
    usage: "/history [会话ID|sync|search]",
    route: "sidebar",
    busy: true,
  },
  {
    name: "plan",
    description: "只读规划，等待明确批准",
    usage: "/plan [需求|off]",
    route: "sidebar",
  },
  {
    name: "approve",
    description: "批准当前最新完成的方案",
    usage: "/approve",
    route: "sidebar",
  },
  {
    name: "model",
    description: "查看原生模型或切换模型",
    usage: "/model [模型ID]",
    route: "sidebar",
  },
  {
    name: "effort",
    description: "设置思考深度，max 依模型支持",
    usage: "/effort [low|medium|high|max]",
    route: "sidebar",
  },
  {
    name: "agents",
    description: "列出自定义主 Agent 定义",
    usage: "/agents",
    route: "sidebar",
    busy: true,
  },
  {
    name: "agent",
    description: "选择主 Agent",
    usage: "/agent [名称|default]",
    route: "sidebar",
  },
  {
    name: "subagents",
    description: "打开真实子代理面板",
    usage: "/subagents",
    route: "sidebar",
    busy: true,
  },
  {
    name: "subagent",
    description: "打开子代理独立对话",
    usage: "/subagent <ID>",
    route: "sidebar",
    busy: true,
  },
  {
    name: "parallel",
    description: "要求原生多 Agent 并行执行",
    usage: "/parallel <需求>",
    route: "sidebar",
  },
  {
    name: "open",
    description: "在编辑器打开文件及行号",
    usage: '/open "文件路径:行号:列号"',
    route: "sidebar",
    busy: true,
  },
  {
    name: "diff",
    description: "查看工作区未提交差异",
    usage: "/diff",
    route: "sidebar",
    busy: true,
  },
  {
    name: "edited",
    description: "列出工作区 Git 改动",
    usage: "/edited",
    route: "sidebar",
    busy: true,
  },
  {
    name: "copy",
    description: "复制完整最近回答或已加载聊天正文",
    usage: "/copy [last|loaded]",
    route: "sidebar",
    busy: true,
  },
  {
    name: "context",
    description: "附加文件、选区或诊断",
    usage: "/context <file|selection|problems>",
    route: "sidebar",
    busy: true,
  },
  {
    name: "workspace",
    description: "查看当前会话目录与配置",
    usage: "/workspace",
    route: "sidebar",
    busy: true,
  },
  {
    name: "add-dir",
    description: "为当前会话添加读取/操作目录",
    usage: '/add-dir "目录"',
    route: "sidebar",
  },
  {
    name: "sandbox",
    description: "配置原生终端限制沙箱",
    usage: "/sandbox <on|off>",
    route: "sidebar",
  },
  {
    name: "schema",
    description: "实验：最终结果使用 JSON Schema，非法或多段 JSON 报错",
    usage: '/schema "文件" 或 /schema off',
    route: "sidebar",
  },
  {
    name: "usage",
    aliases: ["quota"],
    description: "查看已记录 token；quota 转原生",
    usage: "/usage [quota]",
    route: "sidebar",
    busy: true,
  },
  {
    name: "permissions",
    description: "Safe/Danger 或原生细粒度管理",
    usage: "/permissions [safe|danger|native]",
    route: "sidebar",
  },
  {
    name: "skills",
    description: "列出发现的技能，声明支持范围",
    usage: "/skills [refresh]",
    route: "sidebar",
    busy: true,
  },
  {
    name: "skill",
    description: "调用已验证的工作区/全局技能",
    usage: "/skill <名称> [需求]",
    route: "skill",
  },
  {
    name: "mcp",
    description: "列表/启停/移除；添加在原生终端",
    usage: "/mcp [list|enable|disable|remove <名称>|add]",
    route: "sidebar",
  },
  {
    name: "plugins",
    aliases: ["plugin"],
    description: "原生插件管理",
    usage:
      "/plugin [list|validate|install|uninstall|enable|disable|import] [参数]",
    route: "sidebar",
  },
  {
    name: "changelog",
    description: "读取原生版本说明",
    usage: "/changelog",
    route: "sidebar",
    busy: true,
  },
  {
    name: "cli",
    description: "空闲时交接原生 CLI，保留配置",
    usage: "/cli",
    route: "native",
  },
  ...[
    "tasks",
    "btw",
    "goal",
    "schedule",
    "automation",
    "browser",
    "codesearch",
    "grill-me",
    "learn",
    "voice",
    "remote-control",
    "feedback",
    "logout",
    "keybindings",
    "update",
    "install",
    "mic-serve",
    "migrate-workflows",
    "agy-customizations",
    "antigravity-guide",
  ].map((name) => ({
    name,
    aliases: name === "voice" ? ["record"] : undefined,
    description: "原生终端入口；侧栏协议尚未验证",
    usage: `/${name} [参数]`,
    route: "native" as const,
  })),
];
// These rules are shared by help/completion, draft restoration and dispatch validation.
const argumentRules: Record<string, CommandArguments> = {
  diagnostics: {min: 0, max: 1, values: {0: ["export", "clear"]}},
  capabilities: {min: 0, max: 1, values: {0: ["refresh"]}},
  artifact: { min: 0, max: 1 },
  history: { min: 0, max: 1 },
  plan: { min: 0 },
  parallel: { min: 1, max: 1000 },
  model: { min: 0, max: 1 },
  effort: { min: 0, max: 1, values: { 0: ["low", "medium", "high", "max"] } },
  agent: { min: 0, max: 1 },
  subagent: { min: 1, max: 1 },
  open: { min: 1, max: 1 },
  copy: { min: 0, max: 1, values: { 0: ["last", "loaded"] } },
  context: { min: 1, max: 1, values: { 0: ["file", "selection", "problems"] } },
  "add-dir": { min: 1, max: 1 },
  sandbox: { min: 1, max: 1, values: { 0: ["on", "off"] } },
  schema: { min: 1, max: 1 },
  usage: { min: 0, max: 1, values: { 0: ["quota"] } },
  permissions: { min: 0, max: 1, values: { 0: ["safe", "danger", "native"] } },
  skills: { min: 0, max: 1, values: { 0: ["refresh"] } },
  skill: { min: 1 },
  mcp: {
    min: 0,
    defaultOperation: "list",
    forms: [
      { operation: "list", min: 0, max: 1 },
      { operation: "add", min: 1, max: 1 },
      ...["enable", "disable", "remove"].map((operation) => ({
        operation,
        min: 2,
        max: 2,
        rejectFlags: true,
        namePattern: "^[\\w.-]+$",
      })),
    ],
  },
  plugins: {
    min: 0,
    defaultOperation: "list",
    forms: [
      { operation: "list", min: 0, max: 1 },
      { operation: "validate", min: 1, max: 2 },
      ...["enable", "disable", "uninstall"].map((operation) => ({
        operation,
        min: 2,
        max: 2,
        rejectFlags: true,
        namePattern: "^[\\w.@-]+$",
      })),
      ...["install", "import", "link"].map((operation) => ({
        operation,
        min: 1,
        rejectFlags: true,
      })),
    ],
  },
};
const effectRules: Partial<Record<string, CommandEffect[]>> = {
  new: ["history"],
  stop: ["execution"],
  history: ["history"],
  plan: ["configuration", "model"],
  approve: ["configuration", "model"],
  parallel: ["model"],
  model: ["configuration"],
  effort: ["configuration"],
  agent: ["configuration"],
  open: ["editor"],
  diff: ["editor"],
  edited: ["editor"],
  artifact: ["editor", "handoff"],
  copy: ["clipboard"],
  context: ["history"],
  "add-dir": ["configuration"],
  sandbox: ["configuration"],
  schema: ["configuration"],
  permissions: ["configuration", "handoff"],
  usage: ["handoff"],
  skills: ["configuration"],
  skill: ["model"],
  mcp: ["native-management", "configuration"],
  plugins: ["native-management", "configuration"],
  install: ["native-management"],
  update: ["native-management"],
  "mic-serve": ["native-management"],
};
for (const spec of commandRegistry) {
  spec.arguments =
    argumentRules[spec.name] ||
    (spec.route === "native" && spec.name !== "cli" && spec.name !== "update"
      ? { min: 0 }
      : { min: 0, max: 0 });
  spec.draftPolicy =
    spec.route === "sidebar" &&
    !["mcp", "plugins", "new", "stop"].includes(spec.name)
      ? "persist"
      : "memory-only";
  spec.effects =
    effectRules[spec.name] || (spec.route === "native" ? ["handoff"] : []);
  spec.capability =
    spec.route === "native"
      ? "native-terminal"
      : spec.route === "skill" ||
          ["plan", "approve", "parallel"].includes(spec.name)
        ? "stream-json"
        : ["schema", "sandbox"].includes(spec.name)
          ? "experimental"
          : [
                "model",
                "agents",
                "agent",
                "version",
                "capabilities",
                "changelog",
                "mcp",
                "plugins",
              ].includes(spec.name)
            ? "cli-query"
            : "local";
}
export function commandDescription(spec: CommandSpec): string {
  const source =
    spec.capability === "experimental"
      ? "实验"
      : spec.route === "native"
        ? "原生终端"
        : spec.route === "skill"
          ? "原生技能"
          : "侧栏";
  return `${source} · ${spec.busy ? "运行中可用" : "需当前对话空闲"} · ${spec.description}`;
}
export function validateCommand(
  parsed: ParsedCommand,
  state: { busy: boolean; plan: boolean },
) {
  const { spec, args } = parsed;
  const rule = spec.arguments || { min: 0 };
  const invalid = () => {
    throw new Error(
      `用法：${spec.usage}` +
        (["mcp", "plugins"].includes(spec.name)
          ? "；凭据和高级参数请在原生管理终端输入。"
          : ""),
    );
  };
  if (
    args.length < rule.min ||
    (rule.max !== undefined && args.length > rule.max)
  )
    invalid();
  for (const [index, values] of Object.entries(rule.values || {}))
    if (
      args[Number(index)] !== undefined &&
      !values.includes(args[Number(index)])
    )
      invalid();
  if (rule.forms) {
    const form = rule.forms.find(
      (f) => f.operation === (args[0] || rule.defaultOperation),
    );
    if (
      !form ||
      args.length < form.min ||
      (form.max !== undefined && args.length > form.max) ||
      (form.namePattern && !new RegExp(form.namePattern).test(args[1] || "")) ||
      (form.rejectFlags && args.some((value) => value.startsWith("-")))
    )
      invalid();
  }
  if (state.busy && !spec.busy)
    throw new Error(
      `/${spec.name} 需要当前对话空闲；任务未被停止。可使用 /new 或 /stop。`,
    );
  if (state.plan && spec.route === "skill")
    throw new Error("Plan 不执行技能命令，请先 /plan off。");
}
export interface ParsedCommand {
  spec: CommandSpec;
  args: string[];
  tail: string;
}
/** Never put credentials/native management or unknown skill commands on disk. */
export function persistentDraft(text: string): string {
  if (!text.trimStart().startsWith("/") || text.trimStart().startsWith("//"))
    return text;
  try {
    const parsed = parseCommand(text);
    if (!parsed) return text;
    const spec = parsed.spec;
    const policy = spec.draftPolicy || "memory-only";
    return policy === "persist" ? text : "";
  } catch {
    return "";
  }
}
export function parseCommand(
  text: string,
  additional: CommandSpec[] = [],
): ParsedCommand | undefined {
  const value = text.trimStart();
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  const head = value.match(/^\/([a-z][\w-]*)(?:\s|$)/i);
  if (!head)
    throw new Error("无效命令，输入 /help 查看用法；// 可发送普通文字。");
  const name = head[1].toLowerCase();
  const spec = [...commandRegistry, ...additional].find(
    (c) => c.name === name || c.aliases?.includes(name),
  );
  if (!spec) throw new Error(`未知命令 /${name}，输入 /help 查看支持范围。`);
  const tail = value.slice(head[0].length).trim();
  return { spec, args: tokenize(tail), tail };
}
export function tokenize(text: string): string[] {
  const args: string[] = [];
  let current = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && (text[i + 1] === quote || text[i + 1] === "\\"))
        current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) throw new Error("命令参数的引号未闭合。");
  if (started) args.push(current);
  return args;
}
