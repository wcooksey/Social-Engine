import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Campaign, CampaignActivityPage, CampaignChannel, CampaignMode, CampaignSchedule } from '../models/campaign.model';

export interface CampaignInput {
  groupId?: string;
  reEngageAfterDays?: number | null;
  maxCycles?: number;
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

  sendingSummary(id: string): Observable<any> { return this.api.get(`/api/campaigns/${id}/sending-summary`); }
  continuation(id: string): Observable<any> { return this.api.get(`/api/campaigns/${id}/continuation`); }
  continueSequence(id: string, body: unknown): Observable<Campaign> { return this.api.post(`/api/campaigns/${id}/continuation`, body); }
  appendStep(id: string, step: { subject: string; body: string; delayDays: number; approved: boolean }): Observable<Campaign> { return this.api.post<Campaign>(`/api/campaigns/${id}/sequence`, step); }
  updateStep(id: string, stepId: string, step: unknown): Observable<Campaign> { return this.api.patch<Campaign>(`/api/campaigns/${id}/sequence/${stepId}`, step); }
  preview(id: string, leadId: string): Observable<{ subject: string | null; body: string | null; sender: string | null; blockers: string[]; nextEligibleAt: string | null }> { return this.api.get(`/api/campaigns/${id}/preview`, { leadId }); }

  list(groupId?: string): Observable<Campaign[]> {
    return this.api.get<Campaign[]>('/api/campaigns', { groupId });
  }

  get(id: string, groupId?: string): Observable<Campaign> {
    return this.api.get<Campaign>(`/api/campaigns/${id}`, { groupId });
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
