import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  dailySendCap: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  paused: boolean;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class OrganizationService {
  private api = inject(ApiService);

  getMine(): Observable<OrganizationSettings> {
    return this.api.get<OrganizationSettings>('/api/organizations/mine');
  }

  updateMine(patch: Partial<Pick<OrganizationSettings, 'name' | 'dailySendCap' | 'quietHoursStart' | 'quietHoursEnd' | 'paused'>>): Observable<OrganizationSettings> {
    return this.api.patch<OrganizationSettings>('/api/organizations/mine', patch);
  }
}
