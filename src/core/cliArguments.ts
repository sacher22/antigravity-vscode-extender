import type { AgyProcessOptions } from "./agyProcessManager";

/** Both launch routes use identical execution options; only transport differs. */
export function buildCliArguments(
  options: AgyProcessOptions,
  stream = true,
): string[] {
  const args = stream
    ? ["--output-format", "stream-json", "--input-format", "stream-json"]
    : [];
  if (options.isPlanMode && options.dangerouslySkipPermissions)
    throw new Error("只读 Plan 不允许跳过权限确认。");
  if (options.dangerouslySkipPermissions)
    args.push("--dangerously-skip-permissions");
  if (options.agent) args.push("--agent", options.agent);
  if (options.sandbox) args.push("--sandbox");
  if (options.schemaPath) args.push("--json-schema", options.schemaPath);
  if (options.model) args.push("--model", options.model);
  if (options.effort && !/-(low|medium|high)$/.test(options.model || ""))
    args.push("--effort", options.effort);
  args.push("--mode", options.isPlanMode ? "plan" : "accept-edits");
  if (options.createProject) args.push("--new-project");
  for (const dir of options.additionalDirectories || [])
    args.push("--add-dir", dir);
  if (options.conversationId)
    args.push("--conversation", options.conversationId);
  return args;
}
