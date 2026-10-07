import type { ChatMessage, ToolCallItem } from "../core/types";
export type TimelineItem = { key: string; stepIndex: number } & (
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCallItem }
  | { kind: "notice"; text: string }
);
export function messageTimeline(message: ChatMessage): TimelineItem[] {
  const tools = message.toolCalls || [];
  const text = message.blocks?.length
    ? message.blocks
    : message.content
      ? [{ stepIndex: -1, text: message.content }]
      : [];
  // Result-only / legacy prose has no chronological index. Keep it after known steps;
  // no timestamps are invented, and existing indexed records retain their exact order.
  const end =
    Math.max(
      -1,
      ...tools.map((t) => t.stepIndex ?? -1),
      ...text.map((b) => b.stepIndex),
      ...(message.executionNotices || []).map((n) => n.stepIndex),
    ) + 1;
  return [
    ...tools.map((tool, i): TimelineItem => ({
      kind: "tool",
      key: `tool:${tool.stepIndex ?? i}`,
      stepIndex: tool.stepIndex ?? end,
      tool,
    })),
    ...text.map((b, i): TimelineItem => ({
      kind: "text",
      key: `text:${b.stepIndex}:${i}`,
      stepIndex: b.stepIndex < 0 ? end : b.stepIndex,
      text: b.text,
    })),
    ...(message.executionNotices || []).map((n) => ({
      kind: "notice" as const,
      key: `notice:${n.stepIndex}`,
      stepIndex: n.stepIndex,
      text: n.text,
    })),
  ].sort((a, b) => a.stepIndex - b.stepIndex);
}
