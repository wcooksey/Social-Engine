import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Campaign, CampaignActivityPage, CampaignChannel, CampaignMode, CampaignSchedule } from '../models/campaign.model';

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

  /** The next fortnight of scheduled touches for one campaign. */
  schedule(id: string, days = 14): Observable<CampaignSchedule> {
    return this.api.get<CampaignSchedule>(`/api/campaigns/${id}/schedule`, { days });
  }

  /** Move or drop one lead's next touch. */
  updateTouch(
    campaignId: string,
    campaignLeadId: string,
    body: { nextTouchAt?: string | null; status?: string }
  ): Observable<unknown> {
    return this.api.patch(`/api/campaigns/${campaignId}/schedule/${campaignLeadId}`, body);
  }

  saveCycleAngle(campaignId: string, cycle: number, angle: string): Observable<unknown> {
    return this.api.put(`/api/campaigns/${campaignId}/cycles/${cycle}`, { angle });
  }

  deleteCycleAngle(campaignId: string, cycle: number): Observable<unknown> {
    return this.api.delete(`/api/campaigns/${campaignId}/cycles/${cycle}`);
  }

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
