import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AgentJob, AgentRun, AgentUsage } from '../models/agent.model';
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

  getLive(): Observable<AgentLiveSnapshot> {
    return this.api.get<AgentLiveSnapshot>('/api/agent/live');
  }

  getLiveFrame(runId: string): Observable<LiveBrowserFrame> {
    return this.api.get<LiveBrowserFrame>(`/api/agent/live/${runId}/frame`);
  }
}
