import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { DashboardStats } from '../models/dashboard.model';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private api = inject(ApiService);

  getStats(): Observable<DashboardStats> {
    return this.api.get<DashboardStats>('/api/dashboard/stats');
  }
}
