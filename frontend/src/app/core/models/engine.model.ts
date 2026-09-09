/** The playbook a conversation is filed under — its line of business. */
export interface EngineChatPlaybook {
  id: string;
  name: string;
  isActive: boolean;
}

export interface EngineChatSummary {
  groupId?: string | null;
  id: string;
  title: string;
  updatedAt: string;
  playbookId?: string | null;
  playbook?: EngineChatPlaybook | null;
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
  playbookId?: string | null;
  playbook?: EngineChatPlaybook | null;
}

/** Where a run stands. `awaiting_step` = parked in watch mode for the operator. */
export type RunPhase = 'running' | 'paused' | 'awaiting_step' | 'cancelling' | 'finished';

export type RunControlAction = 'pause' | 'resume' | 'cancel' | 'step' | 'watch_on' | 'watch_off';

export type EngineStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolName: string; summary?: string }
  | { type: 'model_failover'; fromModel: string; toModel: string; reason: string }
  | { type: 'run_status'; runId: string; phase: RunPhase; watch: boolean; currentStep?: string }
  | { type: 'done'; runId: string; messageId?: string }
  | { type: 'error'; message: string };

/** Stream items are indexed so a reconnect can resume from where it stopped. */
export interface IndexedStreamEvent {
  index: number;
  event: EngineStreamEvent;
  /** Current-state snapshot sent on attach — carries no position of its own. */
  snapshot?: boolean;
}

/** A run in flight — one card in the fleet view. */
export interface ActiveRun {
  runId: string;
  chatId?: string;
  objective: string;
  trigger: string;
  role: string;
  phase: RunPhase;
  watch: boolean;
  currentStep?: string;
  startedAt: number;
  eventCount: number;
  recentTools: string[];
  watchers: number;
}
