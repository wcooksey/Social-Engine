import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AgentJob, AgentRun, AgentUsage, AutopilotGoal, AutopilotGoalStatus } from '../models/agent.model';
import { AgentLiveSnapshot, LiveBrowserFrame } from '../models/live.model';

export interface AgentRunsPage {
  runs: AgentRun[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class AgentService {
  private api = inject(ApiService);

  listRuns(page = 1): Observable<AgentRunsPage> {
    return this.api.get<AgentRunsPage>('/api/agent/runs', { page });
  }

  getRun(id: string): Observable<AgentRun> {
    return this.api.get<AgentRun>(`/api/agent/runs/${id}`);
  }

  listJobs(params: { status?: string } = {}): Observable<AgentJob[]> {
    return this.api.get<AgentJob[]>('/api/agent/jobs', params);
  }

  getUsage(days: number): Observable<AgentUsage> {
    return this.api.get<AgentUsage>('/api/agent/usage', { days });
  }

  listGoals(): Observable<AutopilotGoal[]> {
    return this.api.get<AutopilotGoal[]>('/api/agent/goals');
  }

  setGoalStatus(id: string, status: AutopilotGoalStatus): Observable<AutopilotGoal> {
    return this.api.patch<AutopilotGoal>(`/api/agent/goals/${id}`, { status });
  }

  getLive(groupId?: string): Observable<AgentLiveSnapshot> {
    return this.api.get<AgentLiveSnapshot>('/api/agent/live', { groupId });
  }

  /**
   * Stop one agent. The server decides how: a live run halts at its next step
   * boundary, one stranded by a restart has its record closed. Both cases land
   * here so the UI never has to know which it is looking at.
   */
  stopRun(runId: string): Observable<{ stopped: boolean; live: boolean; note: string }> {
    return this.api.post<{ stopped: boolean; live: boolean; note: string }>(
      `/api/agent/runs/${runId}/stop`,
      {}
    );
  }

  /** Stop every running agent for this organization, live or stranded. */
  stopAllRuns(): Observable<{ live: number; closed: number; note: string }> {
    return this.api.post<{ live: number; closed: number; note: string }>(
      '/api/agent/runs/stop-all',
      {}
    );
  }

  getLiveFrame(runId: string): Observable<LiveBrowserFrame> {
    return this.api.get<LiveBrowserFrame>(`/api/agent/live/${runId}/frame`);
  }
}
