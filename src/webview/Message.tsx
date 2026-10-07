import { messageTimeline } from "./messageTimeline";
import React, { memo, useMemo, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ToolCallItem } from "../core/types";
import { actionableCodeBlocks } from "../core/codeBlocks";
import { renderMarkdown } from "./renderMarkdown";
import { updateStreamText } from "./longText";
import { VirtualRows } from "./VirtualRows";
import { Tool } from "./ToolDetails";
import { CodeActions } from "./CodeActions";
import { request, renderObserver, renderSourceId } from "./runtime";
const TextBlock = memo(function TextBlock({
  text,
  running,
  stepIndex,
  messageId,
}: {
  text: string;
  running: boolean;
  stepIndex?: number;
  messageId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef("");
  const [linkError, setLinkError] = useState("");
  useLayoutEffect(() => {
    if (!ref.current) return;
    // Plain text while streaming avoids parsing incomplete fences and repeated long Markdown work.
    if (running) {
      updateStreamText(ref.current, text, previous.current);
    } else {
      const timing = renderMarkdown(text, ref.current);
      window.dispatchEvent(
        new CustomEvent("markdown-timing", { detail: timing }),
      );
    }
    previous.current = text;
    renderObserver.domUpdated(
      messageId,
      stepIndex,
      text.length,
      !running,
      ref.current,
    );
  }, [text, running, messageId, stepIndex]);
  return (
    <>
      <div
        ref={ref}
        id={messageId ? renderSourceId(messageId, stepIndex ?? -1) : undefined}
        data-step-index={stepIndex ?? -1}
        data-render-message={messageId}
        data-source-length={text.length}
        data-source-completed={!running}
        className={running ? "stream-text" : "markdown"}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (a) {
            e.preventDefault();
            setLinkError("");
            void request({
              command: "openResource",
              href: a.getAttribute("href") || "",
            }).catch((error) => setLinkError(error.message));
          }
        }}
      />
      {linkError && <div role="alert">{linkError}</div>}
    </>
  );
});
const StructuredText = memo(function StructuredText({
  message,
}: {
  message: ChatMessage;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (ref.current)
      renderObserver.domUpdated(
        message.id,
        -1,
        message.content.length,
        true,
        ref.current,
      );
  }, [message.id, message.content]);
  return (
    <pre
      ref={ref}
      id={message.id ? renderSourceId(message.id, -1) : undefined}
      className="json-result"
      data-render-message={message.id}
      data-step-index={-1}
      data-source-length={message.content.length}
      data-source-completed="true"
    >
      {message.content}
    </pre>
  );
});
export const Message = memo(function Message({
  message,
}: {
  message: ChatMessage;
}) {
  const running = message.status === "running";
  const timeline = useMemo(
    () => messageTimeline(message),
    [
      message.blocks,
      message.toolCalls,
      message.content,
      message.executionNotices,
    ],
  );
  const toolGroups = useRef(new Map<string, ToolCallItem[]>());
  const groups: Array<{
    key: string;
    tools?: ToolCallItem[];
    item?: (typeof timeline)[number];
  }> = [];
  for (const item of timeline) {
    const last = groups.at(-1);
    if (item.kind === "tool") {
      if (last?.tools) last.tools.push(item.tool);
      else groups.push({ key: item.key, tools: [item.tool] });
    } else groups.push({ key: item.key, item });
  }
  const nextGroups = new Map<string, ToolCallItem[]>();
  for (const group of groups)
    if (group.tools) {
      const previous = toolGroups.current.get(group.key);
      if (
        previous &&
        previous.length === group.tools.length &&
        previous.every((tool, i) => tool === group.tools![i])
      )
        group.tools = previous;
      nextGroups.set(group.key, group.tools);
    }
  toolGroups.current = nextGroups;
  const codes = running ? [] : actionableCodeBlocks(message.content);
  return (
    <article className={"message " + message.role} data-message-id={message.id}>
      <div className="role">
        {message.role === "user"
          ? "你"
          : message.role === "assistant"
            ? "Antigravity"
            : "系统"}
        {message.status === "aborted"
          ? " · 已停止"
          : message.status === "interrupted"
            ? " · 已中断"
            : ""}
      </div>
      {message.images?.map((image) => (
        <button
          className="image-preview"
          key={image.file}
          onClick={() =>
            void request({
              command: "openResource",
              href: "file://" + image.file,
            }).catch(() => {})
          }
        >
          <img
            className="image-thumbnail"
            src={image.thumbnail}
            alt={image.title}
          />
        </button>
      ))}
      {message.structuredOutput && !running ? (
        <StructuredText message={message} />
      ) : (
        groups.map((group) =>
          group.tools ? (
            <ToolList
              key={group.key}
              tools={group.tools}
              messageId={message.id!}
            />
          ) : group.item?.kind === "notice" ? (
            <div key={group.key} className="execution-notice" role="status">
              {group.item.text}
            </div>
          ) : group.item?.kind === "text" ? (
            <TextBlock
              key={group.key}
              text={group.item.text}
              running={running}
              stepIndex={group.item.stepIndex}
              messageId={message.id}
            />
          ) : null,
        )
      )}
      {message.permissionRequests?.map((p, i) => (
        <div className="approval" key={i}>
          CLI 自动拒绝的操作：{p.displayName || p.action}
        </div>
      ))}
      {message.agentExecution && (
        <div
          className="approval"
          data-agent-execution={message.agentExecution.state}
        >
          {message.agentExecution.state === "planned"
            ? "多 Agent 分工方案：尚未启动子代理，批准后才执行。"
            : message.agentExecution.state === "waiting"
              ? "多 Agent 执行：等待 CLI 确认子代理启动。"
              : message.agentExecution.state === "started"
                ? `本轮 CLI 已确认 ${message.agentExecution.observedIds.length} 个子代理；详细状态见 Agents 面板。`
                : "未按多 Agent 要求执行。"}
        </div>
      )}
      {message.error && <div role="alert">{message.error}</div>}
      {codes.map(({ code, blockIndex, filePath }) => (
        <CodeActions
          key={blockIndex}
          code={code}
          filePath={filePath}
          blockIndex={blockIndex}
          messageId={message.id!}
        />
      ))}
    </article>
  );
});

const ToolList = memo(function ToolList({
  tools,
  messageId,
}: {
  tools: ToolCallItem[];
  messageId: string;
}) {
  return (
    <VirtualRows
      kind="tool"
      items={tools}
      itemKey={(tool) => String(tool.stepIndex)}
      estimate={30}
      renderItem={(tool) => <Tool tool={tool} messageId={messageId} />}
    />
  );
});
