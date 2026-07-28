import { AgentRole, AgentRunStatus, AgentRunStep } from './agent.model';
import { RunPhase } from './engine.model';

export interface LiveBrowserAction {
  at: string;
  note: string;
}

export interface LiveBrowserState {
  hasFrame: boolean;
  frameAt?: string | null;
  frameUrl?: string | null;
  frameAction?: string | null;
  actions: LiveBrowserAction[];
}

export interface LiveRunningAgent {
  id: string;
  role: AgentRole;
  trigger: string;
  objective: string;
  model?: string | null;
  startedAt: string;
  costUsd?: number | null;
  steps: AgentRunStep[];
  browser: LiveBrowserState | null;
  /** True when the run registry is tracking it — i.e. it can be driven. */
  controllable?: boolean;
  phase?: RunPhase | null;
  watch?: boolean;
  /** What it is about to do, shown while parked in watch mode. */
  currentStep?: string | null;
  chatId?: string | null;
}

export interface LiveFinishedRun {
  id: string;
  role: AgentRole;
  objective: string;
  status: AgentRunStatus;
  summary?: string | null;
  finishedAt: string;
  costUsd?: number | null;
}

export interface AgentLiveSnapshot {
  running: LiveRunningAgent[];
  queuedJobs: number;
  recentFinished: LiveFinishedRun[];
}

export interface LiveBrowserFrame {
  imageBase64: string;
  url?: string | null;
  action?: string | null;
  at?: string | null;
}
