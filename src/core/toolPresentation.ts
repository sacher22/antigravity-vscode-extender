import type { ToolCallItem } from "./types";
export type ToolOutcome =
  "success" | "failed" | "warning" | "background" | "cancelled" | "unknown";
/** Inspect only bounded diagnostic markers, never interpret arbitrary prose as approval/success. */
export function toolOutcome(output?: string): ToolOutcome | undefined {
  const text = (output || "").slice(0, 8192);
  const code = text.match(
    /(?:^|\n)The command exited with code (-?\d+)\.?\r?(?:\n|$)/,
  );
  if (code && Number(code[1]) !== 0) return "failed";
  if (/(?:^|\n)Tool is running as a background task with task id:/.test(text))
    return "background";
  if (
    /(?:^|\n)Traceback \(most recent call last\):/.test(text) ||
    /(?:^|\n)sudo: a password is required\r?(?:\n|$)/.test(text)
  )
    return "warning";
  return undefined;
}
function target(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\r\n\t]+/g, " ").slice(0, 180)
    : "";
}
export function toolPresentation(tool: ToolCallItem): {
  label: string;
  status: string;
  icon: string;
  detail: string;
} {
  const p = tool.parameters || tool.input || {};
  const outcome = tool.outcome || toolOutcome(tool.output);
  const active = tool.state === "ACTIVE";
  const status = active
    ? "正在执行"
    : tool.state === "FAILED" || outcome === "failed"
      ? "执行失败"
      : outcome === "warning"
        ? "输出包含异常"
        : outcome === "background"
          ? "后台执行中"
          : outcome === "cancelled"
            ? "已取消"
            : outcome === "unknown"
              ? "结果未确认"
              : "已完成";
  const completed = !active && status === "已完成";
  let label: string,
    icon = "terminal";
  switch (tool.name) {
    case "view_file":
    case "read_file":
      icon = "file";
      label = `${completed ? "已读取" : active ? "正在读取" : status} ${target(p.AbsolutePath || p.FilePath || p.path) || "文件"}`;
      break;
    case "list_dir":
      icon = "folder";
      label = `${completed ? "已列出" : active ? "正在列出" : status} ${target(p.DirectoryPath || p.path) || "目录"} 中的文件`;
      break;
    case "run_command":
      label = `${completed ? "已运行" : active ? "正在运行" : status} ${target(p.CommandLine || p.command) || "命令"}`;
      break;
    case "write_to_file":
      icon = "file";
      label = `${completed ? "已写入" : active ? "正在写入" : status} ${target(p.TargetFile) || "文件"}`;
      break;
    case "replace_file_content":
    case "multi_replace_file_content":
      icon = "file";
      label = `${completed ? "已修改" : active ? "正在修改" : status} ${target(p.TargetFile) || "文件"}`;
      break;
    case "manage_task":
      label = `${completed ? "已处理" : status} 后台任务 ${target(p.Action)} ${target(p.TaskId)}`;
      break;
    default:
      label = `${status} ${tool.name}`;
  }
  return { label, status, icon, detail: tool.name };
}
