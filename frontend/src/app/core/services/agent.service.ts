import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AgentJob, AgentRun } from '../models/agent.model';

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

  listJobs(): Observable<AgentJob[]> {
    return this.api.get<AgentJob[]>('/api/agent/jobs');
  }
}
