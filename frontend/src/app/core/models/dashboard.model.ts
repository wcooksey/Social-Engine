import { AgentRun } from './agent.model';
import { Activity } from './lead.model';

export interface FunnelStage {
  stage: string;
  count: number;
}

export interface PipelineFunnel {
  funnel: FunnelStage[];
  campaignId: string | null;
}

export interface DashboardStats {
  totalLeads: number;
  totalContacts: number;
  activeCampaigns: number;
  pendingJobs: number;
  leadsByStatus: Record<string, number>;
  recentRuns: AgentRun[];
  recentActivities: Activity[];
}
