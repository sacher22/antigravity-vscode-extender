import type { ChatMessage, SessionMeta, ResultPayload } from "../core/types";
import { PLAN_AGENT } from "../core/planAgent";
import { requestsParallelAgents } from "./executionIntent";

export const PLAN_REQUEST_PREFIX =
  "只做方案，不实施。仅在当前工作区及附加目录内进行必要的读取；不要探查父目录或其他项目。若读取不可用，根据已有信息给出方案并说明假设，不要反复重试。请直接在聊天正文给出方案，完成后停止，等待用户批准。\n\n";

export const PLAN_READ_RECOVERY_PREFIX =
  "读取已被 CLI 自动拒绝，用户没有拒绝，也没有授权扩大范围。现在不要调用任何工具，不要重试读取。请依据已有上下文直接在聊天正文输出完整方案，说明缺失信息与假设，然后停止等待批准。原始任务：\n";

export interface PlanApproval {
  readonly session: SessionMeta;
  readonly message: ChatMessage;
  readonly plan: string;
  readonly parallel: boolean;
}

export function capturePlanApproval(
  session: SessionMeta | null,
  messageId: string,
): PlanApproval {
  const s = session;
  const message = s?.messages.at(-1);
  if (
    !s?.planMode ||
    message?.id !== messageId ||
    message.role !== "assistant" ||
    !message.isPlanMode ||
    message.status !== "completed" ||
    !message.content.trim()
  )
    throw new Error("方案已变化或尚未完成，请查看最新方案后再批准。");
  const plan = message.content;
  const index = s.messages.indexOf(message);
  // Compatibility for saved Plan messages created before execution intent was persisted.
  const userRequest =
    s.messages
      .slice(0, index)
      .reverse()
      .find((m) => m.role === "user")?.content || "";
  const parallel =
    !!message.agentExecution || requestsParallelAgents(userRequest);

  return Object.freeze({
    session: s,
    message,
    plan,
    parallel,
  });
}

export function assertPlanApproval(
  current: SessionMeta | null,
  approval: PlanApproval,
): void {
  if (
    current !== approval.session ||
    approval.session.messages.at(-1) !== approval.message ||
    approval.message.content !== approval.plan ||
    approval.message.status !== "completed"
  )
    throw new Error("批准对象已变化，未提交实施任务。 ");
}

export function shouldRecoverPlanRead(
  planMode: boolean,
  alreadyRecovered: boolean,
  content: string,
  result: ResultPayload,
): boolean {
  return Boolean(
    planMode &&
      !alreadyRecovered &&
      result.denied_actions?.length &&
      result.denied_actions.every((d) => d.action === "read_file") &&
      !content.trim() &&
      !result.response?.trim(),
  );
}

export function hasUsableDeniedPlan(
  planMode: boolean,
  content: string,
  status: "completed" | "failed" | "aborted",
  result: ResultPayload,
): boolean {
  return Boolean(
    planMode &&
      status === "completed" &&
      content.trim().length > 0 &&
      result.denied_actions?.length &&
      result.denied_actions.every((d) => d.action === "read_file"),
  );
}

export function planAgentMatches(
  planMode: boolean,
  actualAgent: unknown,
): boolean {
  return !planMode || actualAgent === PLAN_AGENT;
}
