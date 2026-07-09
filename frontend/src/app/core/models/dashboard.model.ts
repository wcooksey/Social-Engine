import { AgentRun } from './agent.model';
import { Activity } from './lead.model';

export interface DashboardStats {
  totalLeads: number;
  totalContacts: number;
  activeCampaigns: number;
  pendingJobs: number;
  leadsByStatus: Record<string, number>;
  recentRuns: AgentRun[];
  recentActivities: Activity[];
}
