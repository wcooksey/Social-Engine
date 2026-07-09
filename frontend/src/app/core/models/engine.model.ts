export interface EngineChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type EngineMessageRole = 'user' | 'assistant';

export interface EngineToolEvent {
  toolName: string;
  input?: unknown;
  summary?: string;
}

export interface EngineMessage {
  id: string;
  role: EngineMessageRole;
  content: string;
  agentRunId?: string | null;
  createdAt: string;
  /** Client-side only: tool activity chips rendered inline while streaming. */
  toolEvents?: EngineToolEvent[];
  /** Client-side only: true while the assistant message is still streaming. */
  streaming?: boolean;
}

export interface EngineChat {
  id: string;
  title: string;
  messages: EngineMessage[];
}

export type EngineStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolName: string; summary?: string }
  | { type: 'model_failover'; fromModel: string; toModel: string; reason: string }
  | { type: 'done'; runId: string; messageId: string }
  | { type: 'error'; message: string };
