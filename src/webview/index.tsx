import { contextItems } from "../core/contextAttachments";
import React, {
  memo,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { OperationCancelledError } from "../core/operationErrors";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "./AgentPanel";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { request, store } from "./runtime";
import { ExtensionMessage, SessionMeta } from "../core/types";
import { ViewState } from "./state";
const labels: Record<string, string> = {
  approvePlan: "批准方案",
  getAgentDetail: "加载子代理对话",
  ready: "加载会话",
  sendMessage: "发送",
  newSession: "新建对话",
  pickSession: "选择历史",
  switchSession: "切换会话",
  togglePlanMode: "切换模式",
  changeModel: "切换模型",
  togglePermission: "切换权限",
  abortCurrentTurn: "停止",
  openNativeCli: "打开原生 CLI",
  saveDraft: "保存草稿",
  openResource: "打开文件或链接",
};
const SessionOption = memo(function SessionOption({
  session: c,
}: {
  session: ViewState["sessions"][number];
}) {
  return (
    <option value={c.id}>
      {c.title}
      {c.phase &&
        ` · ${c.phase === "exit_unconfirmed" ? "退出未确认" : c.phase === "permission_denied" ? "CLI 自动拒绝" : ["connecting", "submitted", "waiting", "responding", "tool", "stopping"].includes(c.phase) ? "运行中" : c.phase === "completed" ? "已完成" : c.phase === "aborted" ? "已停止" : c.phase}`}
    </option>
  );
});
const SessionOptions = memo(function SessionOptions({
  sessions,
}: {
  sessions: ViewState["sessions"];
}) {
  return (
    <>
      {sessions.map((session) => (
        <SessionOption key={session.id} session={session} />
      ))}
    </>
  );
});

const SessionSelect = memo(function SessionSelect({
  sessions,
  currentId,
  disabled,
  selectSession,
  pickSession,
  totalCount,
}: {
  sessions: ViewState["sessions"];
  currentId: string;
  disabled: boolean;
  selectSession: (id: string) => void;
  pickSession: () => void;
  totalCount: number;
}) {
  const visible = useMemo(() => {
    const recent = sessions.slice(0, 200);
    for (const session of sessions.slice(200)) {
      if (
        session.id !== currentId &&
        session.phase &&
        [
          "connecting",
          "submitted",
          "waiting",
          "responding",
          "tool",
          "awaiting_input",
          "stopping",
          "exit_unconfirmed",
          "permission_denied",
        ].includes(session.phase)
      )
        recent.push(session);
    }
    if (currentId && !recent.some((session) => session.id === currentId)) {
      const current = sessions.find((session) => session.id === currentId);
      if (current) recent.push(current);
    }
    return recent;
  }, [sessions, currentId]);
  const element = useRef<HTMLSelectElement>(null);
  const initialId = useRef(currentId);
  useLayoutEffect(() => {
    // React's controlled-select reconciliation walks every option on every commit.
    // Native value updates are only necessary when the actual selection changed.
    if (element.current && element.current.value !== currentId)
      element.current.value = currentId;
  }, [currentId, sessions, disabled]);
  return (
    <>
      <select
        ref={element}
        id="session-select"
        aria-label="会话"
        defaultValue={initialId.current}
        disabled={disabled}
        onChange={(event) => selectSession(event.target.value)}
      >
        <SessionOptions sessions={visible} />
      </select>
      {totalCount > 200 && (
        <button id="all-history-btn" disabled={disabled} onClick={pickSession}>
          全部历史（{totalCount}）
        </button>
      )}
    </>
  );
});

function App() {
  const s = useSyncExternalStore(store.subscribe, store.snapshot);
  const runRef = useRef(run);
  runRef.current = run;
  const selectSession = useCallback((id: string) => {
    void runRef.current("switchSession", { conversationId: id });
  }, []);
  const pickSession = useCallback(() => {
    void runRef.current("pickSession");
  }, []);
  const [draft, setDraft] = useState("");
  const [completionIndex, setCompletionIndex] = useState(-1);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [attachment, setAttachment] = useState<SessionMeta["attachment"]>();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const expectedScrollTop = useRef(0);
  const lastSession = useRef<string | undefined>(undefined);
  const draftRef = useRef("");
  const attachmentRef = useRef<SessionMeta["attachment"]>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const operation = useRef(new Set<string>());
  const busy =
    !!s.active ||
    !!s.runtime?.terminationPending ||
    !!s.runtime?.executionClaimPending;
  const nativeHandoff = !!s.runtime?.nativeHandoff;
  useEffect(() => {
    void request({ command: "ready" }).catch((e) => setError(e.message));
  }, []);
  useLayoutEffect(() => {
    if (s.session?.id !== lastSession.current) {
      lastSession.current = s.session?.id;
      draftRef.current = s.session?.draft || "";
      setDraft(draftRef.current);
      setCompletionIndex(-1);
      setCompletionDismissed(false);
      setAttachment(s.session?.attachment);
      attachmentRef.current = s.session?.attachment;
      follow.current = true;
      expectedScrollTop.current = 0;
      input.current?.focus();
      setError("");
      updatePending();
    }
  }, [s.session?.id]);
  useEffect(() => {
    setAttachment(s.context);
    attachmentRef.current = s.context;
  }, [s.context]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    // Let completed Markdown parsing finish before measuring its new layout.
    const updateScroll = () => {
      // Scroll events may arrive after streamed DOM updates. Detect an upward move first.
      if (
        element.scrollTop + 4 <
        Math.min(
          expectedScrollTop.current,
          element.scrollHeight - element.clientHeight,
        )
      )
        follow.current = false;
      if (follow.current && s.config.autoScroll !== false)
        element.scrollTop = element.scrollHeight;
      expectedScrollTop.current = element.scrollTop;
    };
    // Preserve synchronous follow behavior during the stream; defer completion only.
    if (s.active) {
      updateScroll();
      return;
    }
    const frame = requestAnimationFrame(updateScroll);
    return () => cancelAnimationFrame(frame);
  }, [s.messages, s.active, s.config.autoScroll]);
  function save() {
    clearTimeout(saveTimer.current);
    if (s.session)
      return request({
        command: "saveDraft",
        text: draftRef.current,
        attachment: attachmentRef.current,
      });
    return Promise.resolve();
  }
  function edit(text: string) {
    setCompletionIndex(-1);
    setCompletionDismissed(false);
    setDraft(text);
    draftRef.current = text;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void save().catch((e) => setError(e.message)),
      250,
    );
  }
  function updatePending() {
    const prefix = (store.state.session?.id || "") + "\0";
    setPending(
      new Set(
        Array.from(operation.current)
          .filter((k) => k === "newSession" || k.startsWith(prefix))
          .map((k) => (k === "newSession" ? k : k.slice(prefix.length))),
      ),
    );
  }
  async function run(
    command: ExtensionMessage["command"],
    data: Partial<ExtensionMessage> = {},
  ) {
    const operationName =
      command === "sendMessage" &&
      typeof (data as { text?: string }).text === "string" &&
      (data as { text: string }).text.trimStart().startsWith("/")
        ? "slash:" + (data as { text: string }).text.trimStart().split(/\s/)[0]
        : command === "requestContext"
          ? "requestContext:" + (data as { contextType?: string }).contextType
          : command;
    const clickedAt = performance.now();
    const submittedText = draftRef.current;
    const key =
      command === "newSession"
        ? command
        : (store.state.session?.id || "") + "\0" + operationName;
    if (operation.current.has(key)) return;
    operation.current.add(key);
    updatePending();
    setError("");
    const originatingSession = store.state.session?.id;
    const previousAcceptedSend = store.state.acceptedSendId;
    try {
      if (
        [
          "newSession",
          "switchSession",
          "pickSession",
          "sendMessage",
          "openNativeCli",
        ].includes(command)
      )
        await save();
      await request({
        command,
        ...data,
        ...(["sendMessage", "abortCurrentTurn"].includes(command)
          ? {
              requestTiming: {
                uiQueuedMs: Math.max(0, performance.now() - clickedAt),
              },
            }
          : {}),
      } as Partial<ExtensionMessage>);
      if (
        command === "sendMessage" &&
        store.state.session?.id === originatingSession &&
        draftRef.current === submittedText
      ) {
        setDraft("");
        draftRef.current = "";
        if (store.state.acceptedSendId !== previousAcceptedSend) {
          setAttachment(undefined);
          attachmentRef.current = undefined;
        }
        // Local commands do not consume attachments, but their successful draft must clear.
        if (store.state.acceptedSendId === previousAcceptedSend) {
          try {
            await save();
          } catch (error) {
            setError(`命令已完成，草稿清理失败：${(error as Error).message}`);
          }
        }
        input.current?.focus();
      }
      if (command === "newSession") input.current?.focus();
    } catch (e) {
      if (
        !(e instanceof OperationCancelledError) &&
        store.state.session?.id === originatingSession
      )
        setError(
          `${operationName.startsWith("slash:") ? operationName.slice(6) : labels[command] || command}失败：${(e as Error).message}`,
        );
    } finally {
      operation.current.delete(key);
      updatePending();
    }
  }
  function send() {
    if (
      (!busy ||
        (draftRef.current.trimStart().startsWith("/") &&
          !draftRef.current.trimStart().startsWith("//"))) &&
      (draftRef.current.trim() ||
        contextItems(attachmentRef.current).some((item) => item.image))
    )
      void run("sendMessage", {
        text: draftRef.current || "请分析附件图片。",
        contextCode: attachmentRef.current?.code,
        filePath: attachmentRef.current?.file,
      });
  }
  const editRef = useRef(edit),
    sendRef = useRef(send);
  editRef.current = edit;
  sendRef.current = send;
  const editInput = useCallback((text: string) => editRef.current(text), []);
  const sendInput = useCallback(() => sendRef.current(), []);
  const candidates = useMemo(
    () =>
      !completionDismissed &&
      draft.startsWith("/") &&
      !draft.startsWith("//") &&
      !/\s/.test(draft)
        ? s.commands
            .filter((c) => c.command.startsWith(draft.toLowerCase()))
            .slice(0, 8)
        : [],
    [completionDismissed, draft, s.commands],
  );
  async function history() {
    const el = scroll.current;
    if (!el) return;
    const top = el.scrollTop,
      height = el.scrollHeight;
    const sessionId = store.state.session?.id;
    const visible = Array.from(
      el.querySelectorAll<HTMLElement>(".message"),
    ).find(
      (message) =>
        message.getBoundingClientRect().bottom >=
        el.getBoundingClientRect().top,
    );
    const anchor = visible?.dataset.messageId
      ? {
          key: visible.dataset.messageId,
          offset: visible.parentElement?.classList.contains("virtual-row")
            ? visible.parentElement.getBoundingClientRect().top -
              el.getBoundingClientRect().top
            : visible.getBoundingClientRect().top -
              el.getBoundingClientRect().top,
        }
      : undefined;
    follow.current = false;
    await run("loadHistory", {
      before: s.messages[0]?.timestamp || Date.now(),
    });
    requestAnimationFrame(() => {
      if (store.state.session?.id !== sessionId) return;
      if (
        anchor &&
        el.querySelector('[data-virtual-kind="message"][data-virtualized]')
      ) {
        el.dispatchEvent(
          new CustomEvent("restore-virtual-anchor", { detail: anchor }),
        );
      } else if (anchor) {
        const message = Array.from(
          el.querySelectorAll<HTMLElement>(".message"),
        ).find((message) => message.dataset.messageId === anchor.key);
        if (message)
          el.scrollTop +=
            message.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            anchor.offset;
        else el.scrollTop = top + el.scrollHeight - height;
      } else el.scrollTop = top + el.scrollHeight - height;
    });
  }
  return (
    <>
      <header>
        <strong>Antigravity</strong>
        <div>
          <button
            id="native-cli-btn"
            disabled={pending.has("openNativeCli")}
            onClick={() => void run("openNativeCli")}
          >
            CLI
          </button>
          <button
            id="new-session-btn"
            aria-label="新建对话"
            disabled={pending.has("newSession")}
            onClick={() => void run("newSession")}
          >
            ＋
          </button>
          <button aria-label="设置" onClick={() => void run("openSettings")}>
            ⚙
          </button>
        </div>
      </header>
      <div className="workspace" title={s.runtime?.workspaceRoot}>
        {s.runtime?.workspaceRoot
          ? s.runtime.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)
          : "请先在 VS Code 打开文件夹"}
        {!s.runtime?.workspaceRoot && (
          <button onClick={() => void run("openWorkspace")}>打开文件夹</button>
        )}
      </div>
      <nav>
        <SessionSelect
          sessions={s.sessions}
          totalCount={s.sessionTotalCount ?? s.sessions.length}
          currentId={s.session?.id || ""}
          disabled={pending.has("switchSession") || pending.has("pickSession")}
          selectSession={selectSession}
          pickSession={pickSession}
        />
        <button
          aria-label="删除当前会话"
          disabled={pending.has("deleteSession")}
          onClick={() =>
            void run("deleteSession", { conversationId: s.session?.id })
          }
        >
          删除
        </button>
      </nav>
      <AgentPanel
        agents={s.agents}
        sessionId={s.session?.id}
        request={request}
      />
      {s.sessions
        .filter((c) => c.phase === "permission_denied")
        .map((c) => (
          <div className="approval" key={c.id}>
            {c.title}：CLI 已自动拒绝操作，没有待审批请求。
            <button
              onClick={() =>
                void run("switchSession", { conversationId: c.id })
              }
            >
              查看所属主对话
            </button>
            {c.id === s.session?.id && (
              <button onClick={() => void run("openNativeCli")}>
                转到 CLI 重试
              </button>
            )}
          </div>
        ))}
      <div
        className="messages"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {s.hasMore && (
          <button
            id="load-history"
            onClick={() => void history()}
            disabled={pending.has("loadHistory")}
          >
            加载更早的消息
          </button>
        )}
        {s.messages.length === 0 && (
          <div className="empty">在当前项目中开始新对话</div>
        )}
        <MessageList messages={s.messages} />
      </div>
      <Composer
        s={s}
        busy={busy}
        nativeHandoff={nativeHandoff}
        pending={pending}
        error={error}
        setError={setError}
        run={run}
        attachment={attachment}
        setAttachment={setAttachment}
        attachmentRef={attachmentRef}
        save={save}
        draft={draft}
        candidates={candidates}
        completionIndex={completionIndex}
        setCompletionIndex={setCompletionIndex}
        setCompletionDismissed={setCompletionDismissed}
        input={input}
        composing={composing}
        compositionEnded={compositionEnded}
        edit={editInput}
        send={sendInput}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
