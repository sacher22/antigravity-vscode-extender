import React, { memo } from "react";
import { imageUpload } from "./imageUpload";
import type { SlashCommandItem } from "../core/types";

export interface ComposerInputProps {
  draft: string;
  planMode: boolean;
  candidates: SlashCommandItem[];
  completionIndex: number;
  setCompletionIndex: React.Dispatch<React.SetStateAction<number>>;
  setCompletionDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  input: React.RefObject<HTMLTextAreaElement | null>;
  composing: React.MutableRefObject<boolean>;
  compositionEnded: React.MutableRefObject<number>;
  edit: (text: string) => void;
  send: () => void;
  pasteImage?: (image: import("../core/types").ImageUpload) => Promise<void>;
  onError?: (message: string) => void;
}

export const ComposerInput = memo(function ComposerInput({
  draft,
  planMode,
  candidates,
  completionIndex,
  setCompletionIndex,
  setCompletionDismissed,
  input,
  composing,
  compositionEnded,
  edit,
  send,
  pasteImage,
  onError,
}: ComposerInputProps) {
  return (
    <>
      {!!candidates.length && (
        <div
          id="slash-completions"
          className="slash-menu"
          role="listbox"
          aria-label="命令补全"
        >
          {candidates.map((c, index) => (
            <button
              key={c.command}
              role="option"
              id={`slash-completion-${index}`}
              aria-selected={completionIndex === index}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                edit(c.command + " ");
                input.current?.focus();
              }}
            >
              <strong>{c.command}</strong> {c.description}
            </button>
          ))}
        </div>
      )}
      <textarea
        id="message-input"
        ref={input}
        value={draft}
        aria-controls={candidates.length ? "slash-completions" : undefined}
        aria-activedescendant={
          completionIndex >= 0 && candidates[completionIndex]
            ? `slash-completion-${completionIndex}`
            : undefined
        }
        placeholder={
          planMode
            ? "只读规划：完成后等待批准，不修改项目…"
            : "输入消息或 /help，Shift+Enter 换行"
        }
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.items)
            .filter(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            )
            .map((item) => item.getAsFile())
            .filter((file): file is File => !!file);
          if (!files.length || !pasteImage) return;
          e.preventDefault();
          void (async () => {
            for (const file of files) await pasteImage(await imageUpload(file));
          })().catch((error) => onError?.(error.message));
        }}
        onChange={(e) => edit(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          compositionEnded.current = Date.now();
        }}
        onKeyDown={(e) => {
          if (
            composing.current ||
            e.nativeEvent.isComposing ||
            e.keyCode === 229 ||
            Date.now() - compositionEnded.current <= 30
          )
            return;
          if (
            candidates.length &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.metaKey
          ) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setCompletionIndex((i) =>
                e.key === "ArrowDown"
                  ? (i + 1) % candidates.length
                  : i <= 0
                    ? candidates.length - 1
                    : i - 1,
              );
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setCompletionDismissed(true);
              setCompletionIndex(-1);
              return;
            }
            if (
              e.key === "Tab" ||
              (e.key === "Enter" && completionIndex >= 0)
            ) {
              e.preventDefault();
              edit(candidates[Math.max(0, completionIndex)].command + " ");
              return;
            }
          }
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !composing.current &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229 &&
            Date.now() - compositionEnded.current > 30
          ) {
            e.preventDefault();
            send();
          }
        }}
      />
    </>
  );
});
