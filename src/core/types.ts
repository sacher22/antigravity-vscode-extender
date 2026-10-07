import type { RequestProbe, RequestReceipt } from "./requestTelemetry";
import type { RenderProbe, RenderReceipt } from "./renderTelemetry";
export interface AntigravityConfig {
  cliPath?: string;
  defaultModel: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  dangerouslySkipPermissions: boolean;
  autoScroll: boolean;
  includeProjectRules?: boolean;
}

export type TurnPhase =
  | "connecting"
  | "submitted"
  | "waiting"
  | "responding"
  | "tool"
  | "awaiting_input"
  | "stopping"
  | "completed"
  | "failed"
  | "aborted"
  | "permission_denied";

export interface TurnState {
  turnId: string;
  sessionId: string;
  generation: number;
  phase: TurnPhase;
  startedAt: number;
  detail?: string;
}

export type PendingInputKind = "confirmation" | "question";

export interface ImageAttachment {
  file: string;
  title: string;
  mime: string;
  bytes: number;
  thumbnail: string;
}
export interface ImageUpload {
  mime: string;
  data: string;
  thumbnail: string;
}
export interface ChatMessage {
  executionNotices?: Array<{ stepIndex: number; text: string }>;
  images?: ImageAttachment[];
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tools?: ToolCallItem[];
  toolCalls?: ToolCallItem[];
  usage?: TokenUsage;
  durationSeconds?: number;
  structuredOutput?: boolean;
  isPlanMode?: boolean;
  agentExecution?: {
    required: number;
    observedIds: string[];
    state: "planned" | "waiting" | "started" | "not_started";
  };
  status?: string;
  pendingInputKind?: PendingInputKind;
  permissionRequests?: Array<{ action: string; displayName: string }>;
  blocks?: Array<{ stepIndex: number; text: string }>;
  error?: string;
}

export interface ToolCallItem {
  outcome?: import("./toolPresentation").ToolOutcome;
  outputRevision?: number;
  stepIndex?: number;
  parameters?: Record<string, unknown>;
  id?: string;
  name: string;
  state: "ACTIVE" | "DONE" | "FAILED";
  input?: Record<string, unknown>;
  output?: string;
}

export interface AgentSummary {
  id: string;
  role: string;
  typeName: string;
  state: "running" | "idle" | "killed" | "failed" | "unknown";
  logUri?: string;
  workspaceUris?: string[];
  startedAt: number;
  updatedAt: number;
  elapsedSeconds?: number;
  usage?: TokenUsage;
}
export interface SubagentInfo {
  subagents: Array<{
    type_name?: string;
    role?: string;
    conversation_id: string;
    log_uri?: string;
    workspace_uris?: string[];
  }>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens: number;
}

export interface StepUpdatePayload {
  conversation_id?: string;
  step_index: number;
  state: "ACTIVE" | "DONE" | "FAILED";
  step_type:
    | "user_input"
    | "agent_response"
    | "tool"
    | "subagent"
    | "checkpoint"
    | "system_message"
    | "error_message";
  error?: string;
  subagent_info?: SubagentInfo;
  tool_name?: string;
  tool_info?: {
    name: string;
    parameters?: Record<string, unknown>;
    output?: string;
  };
  text_delta?: string;
  duration_seconds?: number;
  usage?: TokenUsage;
}

export interface ResultPayload {
  conversation_id?: string;
  status: "SUCCESS" | "ERROR";
  response?: string;
  error?: string;
  duration_seconds: number;
  num_turns?: number;
  denied_actions?: Array<{ action: string; display_name: string }>;
  usage?: TokenUsage;
}

export interface ContextAttachment {
  image?: ImageAttachment;
  code: string;
  file?: string;
  title?: string;
  lineCount?: number;
  uri?: string;
  version?: number;
  bytes?: number;
  fingerprint?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface SessionMeta {
  imageDirectory?: string;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  effort: string;
  totalTokens: number;
  messages: ChatMessage[];
  cliConversationId?: string;
  draft?: string;
  attachment?: ContextAttachment & { items?: ContextAttachment[] };
  workspaceRoot?: string;
  workspaceDirectories?: string[];
  planMode?: boolean;
  dangerouslySkipPermissions?: boolean;
  permissionSource?: "inherited" | "session" | "migrated-default";
  messageCount?: number;
  lastMessageStatus?: ChatMessage["status"];
  agents?: AgentSummary[];
  normalCliConversationId?: string;
  planCliConversationId?: string;
  cliUsageTotal?: number;
  cliUsageTotals?: Record<string, number>;
  planAgentVersion?: number;
  customAgent?: string;
  sandbox?: boolean;
  schemaPath?: string;
  extraDirectories?: string[];
  nativeLogOffsets?: Record<string, number>;
  nativeLogCursors?: Record<string, NativeLogCursor>;
}

export interface NativeLogCursor {
  offset: number;
  observedSize: number;
  fileId?: string;
  headHash?: string;
  tailHash?: string;
}

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  icon?: string;
  category: "General" | "Mode" | "Skills";
  origin?: string;
  isMode?: boolean;
}

export interface MessageIdentity {
  renderProbe?: RenderProbe;
  sessionId?: string;
  turnId?: string;
  generation?: number;
  sequence?: number;
  requestId?: string;
}
export type WebviewMessage = MessageIdentity &
  (
    | {
        type: "initSession";
        session: SessionMeta;
        config: Partial<AntigravityConfig>;
        activeTurn?: { state: TurnState; message: ChatMessage };
        hasMore?: boolean;
      }
    | {
        type: "streamDelta";
        stepIndex: number;
        delta: string;
        receivedAt?: number;
      }
    | {
        type: "toolUpdate";
        outcome?: import("./toolPresentation").ToolOutcome;
        outputRevision?: number;
        stepIndex: number;
        toolName: string;
        state: "ACTIVE" | "DONE" | "FAILED";
        toolInfo?: StepUpdatePayload["tool_info"];
      }
    | { type: "executionNotice"; stepIndex: number; text: string }
    | { type: "stepDone"; stepIndex: number; usage?: TokenUsage }
    | {
        type: "turnComplete";
        receivedAt?: number;
        result: ResultPayload;
        usage?: TokenUsage;
        messageId?: string;
        changes?: Partial<ChatMessage>;
        sessionSummary?: Pick<
          SessionMeta,
          "updatedAt" | "totalTokens" | "messageCount"
        >;
      }
    | { type: "turnAwaitingInput"; kind: PendingInputKind }
    | {
        type: "sessionList";
        totalCount?: number;
        sessions: Array<
          Pick<SessionMeta, "id" | "title" | "updatedAt"> & { phase?: string }
        >;
        currentId: string;
      }
    | {
        type: "statusChange";
        status: "idle" | "running" | "error";
        error?: string;
      }
    | { type: "toolUpdates"; tools: ToolCallItem[] }
    | { type: "turnState"; state: TurnState }
    | { type: "error"; message: string }
    | { type: "slashCommands"; commands: SlashCommandItem[] }
    | { type: "commandResult"; title: string; text: string }
    | { type: "models"; models: string[] }
    | { type: "showAgents"; agentId?: string }
    | { type: "connectionState"; state: "connecting" | "ready" }
    | {
        type: "previewReady";
        previewId: string;
        messageId: string;
        blockIndex: number;
      }
    | { type: "permissionChanged"; dangerouslySkipPermissions: boolean }
    | { type: "modelChanged"; model: string; effort: string }
    | { type: "planModeChanged"; enabled: boolean }
    | {
        type: "setContext";
        attachment?: SessionMeta["attachment"];
        code: string;
        file?: string;
        lineCount?: number;
        title?: string;
      }
    | { type: "requestObserved"; probe: RequestProbe }
    | { type: "sendAccepted" }
    | {
        type: "requestFailed";
        message: string;
        command?: string;
        cancelled?: boolean;
      }
    | { type: "requestComplete"; command: string; targetSessionId?: string }
    | { type: "notice"; message: string }
    | { type: "agents"; agents: AgentSummary[] }
    | {
        type: "agentDetail";
        agentId: string;
        text: string;
        nextOffset: number;
        hasMore: boolean;
      }
    | { type: "historyPage"; messages: ChatMessage[]; hasMore: boolean }
    | {
        type: "toolDetail";
        outputRevision?: number;
        stepIndex: number;
        toolInfo: StepUpdatePayload["tool_info"];
        nextOffset?: number;
        hasMore?: boolean;
      }
    | {
        type: "runtime";
        terminationPending?: boolean;
        executionClaimPending?: boolean;
        executionClaimError?: string;
        nativeHandoff?: boolean;
        workspaceRoot?: string;
        model: string;
        permission: string;
        planMode: boolean;
      }
  );

export type ExtensionMessage = MessageIdentity & {
  requestTiming?: { uiQueuedMs: number };
} & (
    | { command: "pasteImage"; image: ImageUpload }
    | { command: "ready" }
    | { command: "approvePlan"; messageId: string }
    | { command: "getAgents" }
    | { command: "watchAgents"; enabled: boolean }
    | { command: "getAgentDetail"; agentId: string; offset?: number }
    | {
        command: "saveDraft";
        text: string;
        attachment?: SessionMeta["attachment"];
      }
    | {
        command: "sendMessage";
        text: string;
        clientSentAt?: number;
        isPlanMode?: boolean;
        agentExecution?: {
          required: number;
          observedIds: string[];
          state: "planned" | "waiting" | "started" | "not_started";
        };
        contextCode?: string;
        filePath?: string;
      }
    | { command: "abortCurrentTurn" }
    | { command: "newSession" }
    | { command: "pickSession" }
    | { command: "switchSession"; conversationId: string }
    | { command: "deleteSession"; conversationId: string }
    | {
        command: "changeModel";
        model: string;
        effort: "low" | "medium" | "high" | "max";
      }
    | { command: "togglePermission"; dangerouslySkipPermissions: boolean }
    | { command: "togglePlanMode"; isPlanMode: boolean }
    | {
        command: "viewDiff";
        code: string;
        filePath?: string;
        messageId: string;
        blockIndex: number;
      }
    | {
        command: "applyCodeToEditor";
        previewId: string;
        messageId: string;
        blockIndex: number;
        code: string;
      }
    | { command: "copyToClipboard"; text: string }
    | {
        command: "requestContext";
        contextType: "problems" | "file" | "selection";
      }
    | { command: "openSettings" }
    | { command: "openWorkspace" }
    | { command: "reportRender"; receipt: RenderReceipt }
    | { command: "reportRequestLatency"; receipt: RequestReceipt }
    | { command: "openResource"; href: string }
    | { command: "openNativeCli" }
    | { command: "loadHistory"; before: number }
    | {
        command: "getToolDetail";
        messageId?: string;
        stepIndex: number;
        offset?: number;
      }
  );

export type AgyIncomingEvent =
  | { event: "init"; conversation_id: string; init?: Record<string, unknown> }
  | { event: "step_update"; step_update: StepUpdatePayload }
  | { event: "result"; result: ResultPayload }
  | { event: "error"; error: { message: string; code?: string } }
  | { event: string; [key: string]: unknown };
