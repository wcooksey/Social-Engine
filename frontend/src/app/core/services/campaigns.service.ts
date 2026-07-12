import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Campaign, CampaignActivityPage, CampaignChannel, CampaignMode } from '../models/campaign.model';

export interface CampaignInput {
  name: string;
  offer: string;
  channels: CampaignChannel[];
  mode: CampaignMode;
  followUpCadenceDays: number;
  maxTouches: number;
}

@Injectable({ providedIn: 'root' })
export class CampaignsService {
  private api = inject(ApiService);

  list(): Observable<Campaign[]> {
    return this.api.get<Campaign[]>('/api/campaigns');
  }

  get(id: string): Observable<Campaign> {
    return this.api.get<Campaign>(`/api/campaigns/${id}`);
  }

  create(input: CampaignInput): Observable<Campaign> {
    return this.api.post<Campaign>('/api/campaigns', input);
  }

  update(id: string, input: Partial<CampaignInput> & { status?: string }): Observable<Campaign> {
    return this.api.patch<Campaign>(`/api/campaigns/${id}`, input);
  }

  getActivity(id: string, page = 1): Observable<CampaignActivityPage> {
    return this.api.get<CampaignActivityPage>(`/api/campaigns/${id}/activity`, { page });
  }
}
