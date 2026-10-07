import React from "react";
import type {
  ExtensionMessage,
  SessionMeta,
  SlashCommandItem,
} from "../core/types";
import type { ViewState } from "./state";
import { contextItems, combineContext } from "../core/contextAttachments";
import { request } from "./runtime";
import { ComposerInput } from "./ComposerInput";
interface ComposerProps {
  s: ViewState;
  busy: boolean;
  nativeHandoff: boolean;
  pending: Set<string>;
  error: string;
  setError: React.Dispatch<React.SetStateAction<string>>;
  run: (
    command: ExtensionMessage["command"],
    data?: Partial<ExtensionMessage>,
  ) => Promise<void>;
  attachment: SessionMeta["attachment"];
  setAttachment: React.Dispatch<
    React.SetStateAction<SessionMeta["attachment"]>
  >;
  attachmentRef: React.MutableRefObject<SessionMeta["attachment"]>;
  save: () => Promise<void>;
  draft: string;
  candidates: SlashCommandItem[];
  completionIndex: number;
  setCompletionIndex: React.Dispatch<React.SetStateAction<number>>;
  setCompletionDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  input: React.RefObject<HTMLTextAreaElement | null>;
  composing: React.MutableRefObject<boolean>;
  compositionEnded: React.MutableRefObject<number>;
  edit: (text: string) => void;
  send: () => void;
}
export function Composer({
  s,
  busy,
  nativeHandoff,
  pending,
  error,
  setError,
  run,
  attachment,
  setAttachment,
  attachmentRef,
  save,
  draft,
  candidates,
  completionIndex,
  setCompletionIndex,
  setCompletionDismissed,
  input,
  composing,
  compositionEnded,
  edit,
  send,
}: ComposerProps) {
  return (
    <footer>
      {s.runtime?.executionClaimError && (
        <div className="notice" role="status">
          {s.runtime.executionClaimError}
        </div>
      )}
      {nativeHandoff && (
        <div className="notice" role="status">
          此会话由原生 CLI
          终端持有。请在终端继续或停止任务；关闭终端后可在侧栏恢复。新建对话可继续使用。
        </div>
      )}
      {s.commandOutput && (
        <details
          className="command-output"
          open
          key={s.commandOutput.title + s.commandOutput.text}
        >
          <summary>{s.commandOutput.title}</summary>
          <pre>{s.commandOutput.text}</pre>
        </details>
      )}
      {(error || s.error) && (
        <div className="error" role="alert">
          {error || s.error}
        </div>
      )}
      {s.session?.planMode &&
        !busy &&
        !nativeHandoff &&
        s.messages.at(-1)?.role === "assistant" &&
        s.messages.at(-1)?.isPlanMode &&
        s.messages.at(-1)?.status === "completed" &&
        s.messages.at(-1)?.content && (
          <div className="approval">
            方案已完成，等待你确认。
            <button
              id="approve-plan-btn"
              disabled={pending.has("approvePlan")}
              onClick={() =>
                void run("approvePlan", { messageId: s.messages.at(-1)?.id })
              }
            >
              {s.messages.at(-1)?.agentExecution
                ? "批准并以多 Agent 执行方案"
                : "批准并执行方案"}
            </button>
          </div>
        )}
      {!busy &&
        !nativeHandoff &&
        ["failed", "aborted", "interrupted"].includes(
          s.messages.at(-1)?.status || "",
        ) && (
          <button
            id="prepare-resume-btn"
            onClick={() =>
              edit(
                "继续上一轮已批准的任务。先核对已有文件与任务状态，从未完成步骤继续；避免重复已完成的工具操作。先简要说明已完成内容和下一步，再执行。",
              )
            }
          >
            准备续接
          </button>
        )}
      <div className="controls">
        <select
          id="mode-select"
          aria-label="模式"
          value={s.session?.planMode ? "plan" : "normal"}
          disabled={busy || nativeHandoff || pending.has("togglePlanMode")}
          onChange={(e) =>
            void run("togglePlanMode", {
              isPlanMode: e.target.value === "plan",
            })
          }
        >
          <option value="normal">普通</option>
          <option value="plan">Plan</option>
        </select>
        <select
          id="model-select"
          onFocus={() => {
            if (!s.models.length && !busy)
              void request({ command: "sendMessage", text: "/model" }).catch(
                (e) => setError(e.message),
              );
          }}
          aria-label="模型"
          value={s.session?.model || "gemini-3.8-flash-high"}
          disabled={busy || nativeHandoff || pending.has("changeModel")}
          onChange={(e) =>
            void run("changeModel", {
              model: e.target.value,
              effort: (e.target.value.match(/-(low|medium|high)$/)?.[1] ||
                s.session?.effort ||
                "high") as "high",
            })
          }
        >
          {Array.from(
            new Set([
              ...(s.models.length
                ? s.models
                : [
                    "gemini-3.8-flash-high",
                    "gemini-3.7-flash-high",
                    "gemini-3.1-pro-high",
                  ]),
              s.session?.model || "gemini-3.8-flash-high",
            ]),
          ).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select
          aria-label="思考深度"
          value={s.session?.effort || "high"}
          disabled={busy || nativeHandoff || pending.has("changeModel")}
          onChange={(e) =>
            void run("changeModel", {
              model: s.session?.model,
              effort: e.target.value as "high",
            })
          }
        >
          {["high", "medium", "low", "max"].map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <button
          id="permission-btn"
          disabled={
            busy ||
            nativeHandoff ||
            !!s.session?.planMode ||
            pending.has("togglePermission")
          }
          onClick={() =>
            void run("togglePermission", {
              dangerouslySkipPermissions: !s.config.dangerouslySkipPermissions,
            })
          }
        >
          {s.session?.planMode
            ? "Plan 只读"
            : s.config.dangerouslySkipPermissions
              ? "Danger"
              : "Safe"}
        </button>
      </div>
      <div className="effective">
        {s.runtime?.model} · {s.runtime?.permission}{" "}
        {s.active && `· ${s.active.phase}`}
      </div>
      {attachment && (
        <div aria-label="附件列表">
          <div>
            {attachment.bytes ??
              new TextEncoder().encode(attachment.code).byteLength}{" "}
            字节上下文
          </div>
          {contextItems(attachment).map((item, index) => (
            <div className="attachment" key={index}>
              {item.image && (
                <img
                  className="image-thumbnail"
                  src={item.image.thumbnail}
                  alt="截图"
                />
              )}
              {item.file || item.title || "上下文"}
              {item.range &&
                ` · ${item.range.start.line + 1}–${item.range.end.line + 1} 行`}
              {item.bytes !== undefined && ` · ${item.bytes} 字节`}
              <button
                aria-label={`移除上下文 ${index + 1}`}
                onClick={() => {
                  const next = combineContext(
                    contextItems(attachmentRef.current).filter(
                      (_, i) => i !== index,
                    ),
                  );
                  setAttachment(next);
                  attachmentRef.current = next;
                  void save().catch((e) => setError(e.message));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <ComposerInput
        draft={draft}
        planMode={!!s.session?.planMode}
        candidates={candidates}
        completionIndex={completionIndex}
        setCompletionIndex={setCompletionIndex}
        setCompletionDismissed={setCompletionDismissed}
        input={input}
        composing={composing}
        compositionEnded={compositionEnded}
        edit={edit}
        send={send}
        pasteImage={(image) =>
          request({ command: "pasteImage", sessionId: s.session?.id, image })
        }
        onError={setError}
      />
      <div className="actions">
        <button
          onClick={() => void run("requestContext", { contextType: "file" })}
        >
          文件
        </button>
        <button
          onClick={() =>
            void run("requestContext", { contextType: "selection" })
          }
        >
          选区
        </button>
        <button
          onClick={() =>
            void run("requestContext", { contextType: "problems" })
          }
        >
          报错
        </button>
        {busy &&
          draft.trimStart().startsWith("/") &&
          !draft.trimStart().startsWith("//") && (
            <button
              id="command-send-btn"
              disabled={pending.has(
                "slash:" + draft.trimStart().split(/\s/)[0],
              )}
              onClick={send}
            >
              执行命令
            </button>
          )}
        {busy ? (
          <button
            id="stop-btn"
            disabled={pending.has("abortCurrentTurn")}
            onClick={() => void run("abortCurrentTurn")}
          >
            {s.runtime?.executionClaimPending && !s.active
              ? "重试释放执行锁"
              : "停止"}
          </button>
        ) : (
          <button
            id="send-btn"
            disabled={
              (!draft.trim() &&
                !contextItems(attachment).some((item) => item.image)) ||
              (nativeHandoff && !draft.trimStart().startsWith("/")) ||
              pending.has("sendMessage") ||
              pending.has("slash:" + draft.trimStart().split(/\s/)[0]) ||
              (!s.runtime?.workspaceRoot && !draft.trimStart().startsWith("/"))
            }
            onClick={send}
          >
            发送
          </button>
        )}
      </div>
    </footer>
  );
}
