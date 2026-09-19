export interface AntigravityConfig {
  cliPath?: string;
  defaultModel: string;
  reasoningEffort: "low" | "medium" | "high";
  dangerouslySkipPermissions: boolean;
  autoScroll: boolean;
  includeProjectRules?: boolean;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tools?: ToolCallItem[];
  toolCalls?: ToolCallItem[];
  usage?: TokenUsage;
  durationSeconds?: number;
  isPlanMode?: boolean;
  status?: string;
}

export interface ToolCallItem {
  stepIndex?: number;
  parameters?: Record<string, unknown>;
  id?: string;
  name: string;
  state: "ACTIVE" | "DONE" | "FAILED";
  input?: Record<string, unknown>;
  output?: string;
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
  step_type: "user_input" | "agent_response" | "tool";
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
  usage?: TokenUsage;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  effort: string;
  totalTokens: number;
  messages: ChatMessage[];
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

export type WebviewMessage =
  | { type: "initSession"; session: SessionMeta; sessions: SessionMeta[]; models: string[]; config: AntigravityConfig; slashItems: SlashCommandItem[] }
  | { type: "streamDelta"; stepIndex: number; delta: string }
  | { type: "toolUpdate"; stepIndex: number; toolName: string; state: "ACTIVE" | "DONE" | "FAILED"; info: any }
  | { type: "stepDone"; stepIndex: number; usage?: TokenUsage }
  | { type: "turnComplete"; result: ResultPayload }
  | { type: "sessionList"; sessions: SessionMeta[]; currentSessionId: string }
  | { type: "statusChange"; status: "idle" | "running" | "error"; error?: string }
  | { type: "error"; message: string }
  | { type: "slashCommands"; items: SlashCommandItem[] };

export type ExtensionMessage =
  | { command: "ready" }
  | { command: "sendMessage"; text: string; isPlanMode?: boolean; contextCode?: string; filePath?: string }
  | { command: "abortCurrentTurn" }
  | { command: "newSession" }
  | { command: "switchSession"; conversationId: string }
  | { command: "deleteSession"; conversationId: string }
  | { command: "changeModel"; model: string; effort: "low" | "medium" | "high" }
  | { command: "toggleDangerousPermissions"; enabled: boolean }
  | { command: "togglePermission"; dangerouslySkipPermissions: boolean }
  | { command: "insertAtCursor"; text?: string; code?: string }
  | { command: "applyDiff"; text?: string; code?: string; filePath?: string }
  | { command: "viewDiff"; text?: string; code?: string; filePath?: string }
  | { command: "applyToFile"; text?: string; code?: string }
  | { command: "applyCodeToEditor"; text?: string; code?: string; mode?: "insert" | "replace" | "newFile" }
  | { command: "copyToClipboard"; text: string }
  | { command: "requestProblemsContext" }
  | { command: "requestFileContext" }
  | { command: "requestContext"; contextType: "problems" | "file" }
  | { command: "openSettings" }
  | { command: "getSlashCommands" };

export type AgyIncomingEvent = any;
