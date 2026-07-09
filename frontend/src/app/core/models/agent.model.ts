export type AgentRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

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
  summary?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  stepCount: number;
  steps?: AgentRunStep[];
}

export interface AgentJob {
  id: string;
  type: string;
  objective: string;
  runAt: string;
  status: string;
  lead?: { id: string; companyName: string } | null;
  campaign?: { id: string; name: string } | null;
}
