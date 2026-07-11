export type AgentRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type AgentRole = 'COORDINATOR' | 'RESEARCHER' | 'CALLER' | 'SDR';

export interface AgentRunStep {
  index: number;
  type: string;
  toolName?: string | null;
  input?: unknown;
  output?: unknown;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  trigger: string;
  objective: string;
  status: AgentRunStatus;
  role: AgentRole;
  summary?: string | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  stepCount: number;
  steps?: AgentRunStep[];
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

export interface AgentUsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentUsageByModel {
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentUsageByDay {
  day: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runs: number;
}

export interface AgentUsage {
  days: number;
  totals: AgentUsageTotals;
  byModel: AgentUsageByModel[];
  byDay: AgentUsageByDay[];
  note?: string;
}

export interface AgentJob {
  id: string;
  type: string;
  objective: string;
  runAt: string;
  status: string;
  role: AgentRole;
  lead?: { id: string; companyName: string } | null;
  campaign?: { id: string; name: string } | null;
}

export type AutopilotGoalStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface AutopilotGoal {
  id: string;
  name: string;
  objective: string;
  role: AgentRole;
  status: AutopilotGoalStatus;
  cadenceHours: number;
  targetLeadCount?: number | null;
  nextRunAt: string;
  lastQueuedAt?: string | null;
  lastResult?: string | null;
  leadGroup?: { id: string; name: string } | null;
  campaign?: { id: string; name: string } | null;
  createdAt: string;
}
