import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { DashboardStats, PipelineFunnel } from '../models/dashboard.model';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private api = inject(ApiService);

  getStats(): Observable<DashboardStats> {
    return this.api.get<DashboardStats>('/api/dashboard/stats');
  }

  getFunnel(campaignId?: string): Observable<PipelineFunnel> {
    return this.api.get<PipelineFunnel>('/api/dashboard/funnel', { campaignId });
  }
}
