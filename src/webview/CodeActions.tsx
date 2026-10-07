import React, { useEffect, useState } from "react";
import type { ExtensionMessage } from "../core/types";
import { request, store } from "./runtime";
export function CodeActions({
  code,
  filePath,
  messageId,
  blockIndex,
}: {
  filePath?: string;
  code: string;
  messageId: string;
  blockIndex: number;
}) {
  const [previewId, setPreviewId] = useState<string>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setPreviewId(undefined);
    const ready = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (
        message.messageId === messageId &&
        message.blockIndex === blockIndex &&
        message.sessionId === store.state.session?.id
      )
        setPreviewId(message.previewId);
    };
    window.addEventListener("code-preview", ready);
    return () => window.removeEventListener("code-preview", ready);
  }, [code, messageId, blockIndex]);
  async function act(
    command: "viewDiff" | "applyCodeToEditor" | "copyToClipboard",
  ) {
    setError("");
    setPending(true);
    if (command === "viewDiff") setPreviewId(undefined);
    try {
      await request({
        command,
        code,
        filePath,
        messageId,
        blockIndex,
        previewId,
        text: code,
      } as Partial<ExtensionMessage>);
      if (command === "applyCodeToEditor") setPreviewId(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="code-actions">
      <button disabled={pending} onClick={() => void act("copyToClipboard")}>
        复制代码
      </button>
      {filePath && (
        <button disabled={pending} onClick={() => void act("viewDiff")}>
          预览差异（替换整文件）
        </button>
      )}
      {filePath && (
        <button
          disabled={pending || !previewId}
          onClick={() => void act("applyCodeToEditor")}
        >
          应用预览
        </button>
      )}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}
