export type CampaignChannel = 'EMAIL' | 'SMS' | 'VOICE' | 'SOCIAL';
export type CampaignMode = 'AUTONOMOUS' | 'APPROVAL_REQUIRED';
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

export interface Campaign {
  id: string;
  name: string;
  offer: string;
  channels: CampaignChannel[];
  mode: CampaignMode;
  status: CampaignStatus;
  followUpCadenceDays: number;
  maxTouches: number;
  leadCount: number;
  createdAt: string;
}
