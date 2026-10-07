import { toolPresentation } from "../core/toolPresentation";
import React, { memo, useEffect, useRef, useState } from "react";
import type { ToolCallItem } from "../core/types";
import { request } from "./runtime";
export const Tool = memo(function Tool({
  tool,
  messageId,
}: {
  tool: ToolCallItem;
  messageId: string;
}) {
  const [output, setOutput] = useState(tool.output || "");
  const [page, setPage] = useState({ offset: 0, hasMore: false });
  const loading = useRef(false);
  const details = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setOutput(tool.output || "");
    setPage({ offset: 0, hasMore: false });
    loading.current = false;
    if (!details.current?.open) return;
    const timer = setTimeout(() => {
      if (details.current?.open)
        void request({
          command: "getToolDetail",
          messageId,
          stepIndex: tool.stepIndex || 0,
        }).catch((error) => setError(error.message));
    }, 300);
    return () => clearTimeout(timer);
  }, [tool.outputRevision, tool.output]);
  useEffect(() => {
    const handler = (e: Event) => {
      const m = (e as CustomEvent).detail;
      if (
        m.requestId === messageId &&
        m.stepIndex === tool.stepIndex &&
        (m.outputRevision === undefined ||
          m.outputRevision === tool.outputRevision)
      ) {
        setOutput((old) =>
          loading.current
            ? old + (m.toolInfo.output || "")
            : m.toolInfo.output || "",
        );
        loading.current = false;
        setPage({ offset: m.nextOffset || 0, hasMore: !!m.hasMore });
      }
    };
    window.addEventListener("tool-detail", handler);
    return () => window.removeEventListener("tool-detail", handler);
  }, [messageId, tool.stepIndex, tool.outputRevision]);
  const presentation = toolPresentation(tool);
  return (
    <details
      className="tool"
      ref={details}
      onToggle={(e) => {
        if (e.currentTarget.open)
          void request({
            command: "getToolDetail",
            messageId,
            stepIndex: tool.stepIndex || 0,
          }).catch((error) => setError(error.message));
      }}
    >
      {error && <div role="alert">{error}</div>}
      <summary
        title={presentation.label}
        data-tool-status={presentation.status}
      >
        <svg
          className="tool-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          {presentation.icon === "folder" ? (
            <path d="M3 7V5h7l2 2h9v13H3z" />
          ) : presentation.icon === "file" ? (
            <path d="M6 3h8l4 4v14H6zM14 3v5h4" />
          ) : (
            <>
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="m7 9 3 3-3 3m6 0h4" />
            </>
          )}
        </svg>
        <span className="tool-summary-text">{presentation.label}</span>
      </summary>
      <pre>{JSON.stringify(tool.parameters || {}, null, 2)}</pre>
      <pre>{output}</pre>
      {page.hasMore && (
        <button
          onClick={() => {
            loading.current = true;
            void request({
              command: "getToolDetail",
              messageId,
              stepIndex: tool.stepIndex || 0,
              offset: page.offset,
            }).catch(() => {
              loading.current = false;
            });
          }}
        >
          加载更多输出
        </button>
      )}
    </details>
  );
});
