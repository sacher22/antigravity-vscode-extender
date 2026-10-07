import React, {memo, useEffect, useRef, useState} from "react";
import type {AgentSummary, ExtensionMessage} from "../core/types";
import {DetailRequestGate} from "./detailRequestGate";

const agentStates: Record<string, string> = {
  running: "运行中（最近观察）",
  idle: "已完成 / 空闲",
  killed: "已停止",
  failed: "失败",
  unknown: "状态待同步",
};
const AgentCard = memo(function AgentCard({
  agent,
  now,
  select,
}: {
  agent: AgentSummary;
  now: number;
  select: () => void;
}) {
  const elapsed =
    agent.elapsedSeconds ?? Math.max(0, (now - agent.startedAt) / 1000);
  return (
    <button className="agent-card" onClick={select} data-agent-id={agent.id}>
      <strong>{agent.role}</strong>
      <span>{agentStates[agent.state]}</span>
      <span>
        {Math.floor(elapsed)} 秒 ·{" "}
        {agent.usage ? `${agent.usage.total_tokens} tokens` : "Token 暂不可用"}
      </span>
    </button>
  );
});
export function AgentPanel({
  agents,
  sessionId,
  request,
}: {
  agents: AgentSummary[];
  sessionId?: string;
  request: (data: Partial<ExtensionMessage>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState({ text: "", nextOffset: 0, hasMore: false });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const cursor = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const gateRef = useRef<DetailRequestGate | undefined>(undefined);
  const gate = gateRef.current || (gateRef.current = new DetailRequestGate());
  gate.select(sessionId);
  useEffect(() => () => gate.invalidate(), [gate]);
  useEffect(() => {
    gate.invalidate();
    setLoading(false);
    setError("");
    cursor.current = 0;
    setSelected(undefined);
    selectedRef.current = undefined;
    setOpen(false);
    setPage({ text: "", nextOffset: 0, hasMore: false });
  }, [sessionId]);
  useEffect(() => {
    void request({ command: "watchAgents", enabled: open }).catch(
      () => undefined,
    );
    if (!open) return;
    const onVisibility = () => {
      void request({ command: "watchAgents", enabled: !document.hidden }).catch(
        () => undefined,
      );
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open, sessionId]);
  useEffect(() => {
    const listener = (event: Event) => {
      const m = (event as CustomEvent).detail;
      if (
        m.agentId !== selectedRef.current ||
        m.sessionId !== sessionRef.current
      )
        return;
      setPage((p) => ({
        text: cursor.current ? p.text + "\n\n" + m.text : m.text,
        nextOffset: m.nextOffset,
        hasMore: m.hasMore,
      }));
    };
    window.addEventListener("agent-detail", listener);
    return () => window.removeEventListener("agent-detail", listener);
  }, []);
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.sessionId && detail.sessionId !== sessionRef.current) return;
      setOpen(true);
      if (detail.agentId) void load(detail.agentId);
    };
    window.addEventListener("show-agents", show);
    return () => window.removeEventListener("show-agents", show);
  }, [sessionId, loading]);
  async function load(id: string, offset = 0) {
    const origin = sessionRef.current;
    const ticket = gate.begin(origin, id, offset);
    if (!ticket) return;
    selectedRef.current = id;
    setSelected(id);
    setError("");
    setLoading(true);
    cursor.current = offset;
    try {
      await request({ command: "getAgentDetail", sessionId: origin, agentId: id, offset });
    } catch (e) {
      if (gate.current(ticket) && sessionRef.current === origin)
        setError((e as Error).message);
    } finally {
      if (gate.finish(ticket)) setLoading(false);
    }
  }
  return (
    <section className="agent-panel">
      <button
        id="agents-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {agents.length} Agents
      </button>
      {open && (
        <div className="agent-content">
          <div className="agent-grid">
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                now={now}
                select={() => {
                  void load(a.id);
                }}
              />
            ))}
          </div>
          {!agents.length && <p>当前对话没有子代理。</p>}
          <small>状态以 CLI 最近报告为准；子代理内部记录仅在此处加载。</small>
          {selected && (
            <div className="agent-dialog">
              <strong>{agents.find((a) => a.id === selected)?.role}</strong>
              <button
                disabled={loading}
                onClick={() => {
                  void load(selected);
                }}
              >
                刷新对话
              </button>
              {error && <div role="alert">{error}</div>}
              <pre className="agent-transcript">
                {page.text || (loading ? "加载中…" : "尚无可见消息")}
              </pre>
              {page.hasMore && (
                <button
                  disabled={loading}
                  onClick={() => {
                    void load(selected, page.nextOffset);
                  }}
                >
                  加载更多
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

