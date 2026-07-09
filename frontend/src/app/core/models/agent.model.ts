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
