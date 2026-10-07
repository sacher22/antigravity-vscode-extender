import {
  AgentSummary,
  ChatMessage,
  SessionMeta,
  TurnState,
  WebviewMessage,
  AntigravityConfig,
  ExtensionMessage,
  SlashCommandItem,
  ToolCallItem,
} from "../core/types";

function reuseTools(
  previous: ToolCallItem[] | undefined,
  incoming: ToolCallItem[] | undefined,
) {
  if (!previous || !incoming) return incoming;
  const byStep = new Map(previous.map((tool) => [tool.stepIndex, tool]));
  let unchanged = previous.length === incoming.length;
  const tools = incoming.map((tool, index) => {
    const old = byStep.get(tool.stepIndex);
    const equal =
      old &&
      old.id === tool.id &&
      old.name === tool.name &&
      old.state === tool.state &&
      old.outcome === tool.outcome &&
      old.output === tool.output &&
      old.outputRevision === tool.outputRevision &&
      JSON.stringify(old.parameters) === JSON.stringify(tool.parameters) &&
      JSON.stringify(old.input) === JSON.stringify(tool.input);
    const next = equal ? old : tool;
    if (previous[index] !== next) unchanged = false;
    return next;
  });
  return unchanged ? previous : tools;
}
/** Public list snapshots retain unchanged rows so a phase change does not rerender every option. */
function reuseSessions(
  previous: ViewState["sessions"],
  incoming: ViewState["sessions"],
): ViewState["sessions"] {
  const byId = new Map(previous.map((session) => [session.id, session]));
  let unchanged = previous.length === incoming.length;
  const sessions = incoming.map((session, i) => {
    const prior = byId.get(session.id);
    const reused =
      prior &&
      (prior === session ||
        (prior.title === session.title &&
          prior.updatedAt === session.updatedAt &&
          prior.phase === session.phase))
        ? prior
        : session;
    if (reused !== previous[i]) unchanged = false;
    return reused;
  });
  return unchanged ? previous : sessions;
}
export interface ViewState {
  session?: SessionMeta;
  messages: ChatMessage[];
  active?: TurnState;
  sessions: Array<{
    id: string;
    title: string;
    updatedAt: number;
    phase?: string;
  }>;
  sessionTotalCount?: number;
  agents: AgentSummary[];
  config: Partial<AntigravityConfig>;
  runtime?: {
    terminationPending?: boolean;
    executionClaimPending?: boolean;
    executionClaimError?: string;
    nativeHandoff?: boolean;
    workspaceRoot?: string;
    model: string;
    permission: string;
    planMode: boolean;
  };
  hasMore: boolean;
  commands: SlashCommandItem[];
  models: string[];
  commandOutput?: { title: string; text: string };
  acceptedSendId?: string;
  error?: string;
  context?: SessionMeta["attachment"];
}
export class ViewStore {
  state: ViewState = {
    messages: [],
    sessions: [],
    agents: [],
    config: {},
    hasMore: false,
    commands: [],
    models: [],
  };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private resyncing = false;
  constructor(
    private readonly request: (
      data: Partial<ExtensionMessage>,
    ) => Promise<void> | void,
    private readonly accepted?: (
      message: WebviewMessage,
      state: ViewState,
    ) => void,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  receive = (m: WebviewMessage) => {
    if (m.sequence !== undefined) {
      if (
        m.type !== "initSession" &&
        this.sequence &&
        m.sequence !== this.sequence + 1
      ) {
        if (!this.resyncing) {
          this.resyncing = true;
          Promise.resolve(this.request({ command: "ready" })).catch(() => {
            this.resyncing = false;
          });
        }
        return;
      }
      if (m.sequence <= this.sequence) return;
      this.sequence = m.sequence;
    }
    if (
      m.type !== "initSession" &&
      m.type !== "sessionList" &&
      m.sessionId &&
      m.sessionId !== this.state.session?.id
    )
      return;
    let s = this.state;
    switch (m.type) {
      case "initSession": {
        this.resyncing = false;
        const active = m.activeTurn;
        const previous =
          s.session?.id === m.session.id
            ? new Map(s.messages.map((message) => [message.id, message]))
            : new Map<string | undefined, ChatMessage>();
        const messages = (
          active ? [...m.session.messages, active.message] : m.session.messages
        ).map((message) => ({
          ...message,
          toolCalls: reuseTools(
            previous.get(message.id)?.toolCalls,
            message.toolCalls,
          ),
        }));
        s = {
          ...s,
          session: m.session,
          agents: m.session.agents || [],
          messages,
          active: active?.state,
          config: m.config,
          hasMore: !!m.hasMore,
          context: m.session.attachment,
          error: undefined,
          commandOutput:
            s.session?.id === m.session.id ? s.commandOutput : undefined,
        };
        break;
      }
      case "slashCommands":
        s = { ...s, commands: m.commands };
        break;
      case "models":
        s = { ...s, models: m.models };
        break;
      case "commandResult":
        s = { ...s, commandOutput: { title: m.title, text: m.text } };
        break;
      case "sendAccepted":
        s = { ...s, acceptedSendId: m.requestId };
        break;
      case "sessionList":
        s = {
          ...s,
          sessions: reuseSessions(s.sessions, m.sessions),
          sessionTotalCount: m.totalCount ?? m.sessions.length,
        };
        break;
      case "agents":
        s = { ...s, agents: m.agents };
        break;
      case "runtime":
        s = { ...s, runtime: m };
        break;
      case "turnState":
        if (
          s.active &&
          m.state.turnId !== s.active.turnId &&
          m.state.phase !== "connecting"
        )
          return;
        s = {
          ...s,
          active: [
            "completed",
            "failed",
            "aborted",
            "permission_denied",
          ].includes(m.state.phase)
            ? undefined
            : m.state,
        };
        break;
      case "turnComplete": {
        if (!m.messageId || !m.changes) break;
        if (s.active && m.turnId !== s.active.turnId) return;
        const index = s.messages.findIndex(
          (message) => message.id === m.messageId,
        );
        if (index < 0) {
          if (!this.resyncing) {
            this.resyncing = true;
            Promise.resolve(this.request({ command: "ready" })).catch(() => {
              this.resyncing = false;
            });
          }
          return;
        }
        const messages = [...s.messages];
        const previous = messages[index];
        messages[index] = {
          ...previous,
          ...m.changes,
          toolCalls: m.changes.toolCalls
            ? reuseTools(previous.toolCalls, m.changes.toolCalls)
            : previous.toolCalls,
        };
        s = {
          ...s,
          messages,
          active: undefined,
          session: s.session
            ? { ...s.session, ...m.sessionSummary }
            : s.session,
        };
        break;
      }
      case "executionNotice": {
        const last = s.messages.at(-1);
        if (last?.role !== "assistant") break;
        const notices = (last.executionNotices || []).filter(
          (n) => n.stepIndex !== m.stepIndex,
        );
        s = {
          ...s,
          messages: [
            ...s.messages.slice(0, -1),
            {
              ...last,
              executionNotices: [
                ...notices,
                { stepIndex: m.stepIndex, text: m.text },
              ],
            },
          ],
        };
        break;
      }
      case "streamDelta": {
        if (
          !s.active ||
          m.turnId !== s.active.turnId ||
          m.generation !== s.active.generation
        )
          return;
        const last = s.messages.at(-1);
        if (!last || last.role !== "assistant") return;
        const blocks = [...(last.blocks || [])];
        const i = blocks.findIndex((b) => b.stepIndex === m.stepIndex);
        if (i < 0) blocks.push({ stepIndex: m.stepIndex, text: m.delta });
        else blocks[i] = { ...blocks[i], text: blocks[i].text + m.delta };
        const changed = { ...last, blocks, content: last.content + m.delta };
        s = { ...s, messages: [...s.messages.slice(0, -1), changed] };
        break;
      }
      case "toolUpdates":
      case "toolUpdate": {
        if (
          !s.active ||
          m.turnId !== s.active.turnId ||
          m.generation !== s.active.generation
        )
          return;
        const last = s.messages.at(-1);
        if (!last || last.role !== "assistant") return;
        const tools = [...(last.toolCalls || [])];
        const indices = new Map(
          tools.map((tool, index) => [tool.stepIndex, index]),
        );
        const updates =
          m.type === "toolUpdates"
            ? m.tools
            : [
                {
                  stepIndex: m.stepIndex,
                  name: m.toolName,
                  outcome: m.outcome,
                  state: m.state,
                  parameters: m.toolInfo?.parameters,
                  output: m.toolInfo?.output,
                  outputRevision: m.outputRevision,
                },
              ];
        for (const item of updates) {
          const index = indices.get(item.stepIndex);
          if (index === undefined) {
            indices.set(item.stepIndex, tools.length);
            tools.push(item);
          } else tools[index] = item;
        }
        s = {
          ...s,
          messages: [...s.messages.slice(0, -1), { ...last, toolCalls: tools }],
        };
        break;
      }
      case "historyPage": {
        const ids = new Set(s.messages.map((m) => m.id));
        s = {
          ...s,
          messages: [
            ...m.messages.filter((m) => !ids.has(m.id)),
            ...s.messages,
          ],
          hasMore: m.hasMore,
        };
        break;
      }
      case "setContext":
        s = {
          ...s,
          context: m.attachment || {
            code: m.code,
            file: m.file,
            lineCount: m.lineCount,
            title: m.title,
          },
        };
        break;
      case "requestComplete":
        s = { ...s, error: undefined };
        break;
      case "requestFailed":
        s = { ...s, error: m.message };
        break;
      case "error":
      case "notice":
        s = { ...s, error: m.message };
        break;
      default:
        return;
    }
    this.state = s;
    this.accepted?.(m, s);
    for (const l of this.listeners) l();
  };
}
