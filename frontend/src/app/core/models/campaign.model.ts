export type CampaignChannel = 'EMAIL' | 'SMS' | 'VOICE' | 'SOCIAL';
export type CampaignMode = 'AUTONOMOUS' | 'APPROVAL_REQUIRED';
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

export type CampaignLeadStatus =
  | 'PENDING'
  | 'IN_SEQUENCE'
  | 'REPLIED'
  | 'INTERESTED'
  | 'NOT_INTERESTED'
  | 'COMPLETED'
  | 'REMOVED';

export interface CampaignLeadEntry {
  id: string;
  status: CampaignLeadStatus;
  touchCount: number;
  lastTouchAt?: string | null;
  nextTouchAt?: string | null;
  createdAt: string;
  lead: {
    id: string;
    companyName: string;
    status: string;
    city?: string | null;
    state?: string | null;
    doNotContact?: boolean;
  };
}

export interface CampaignActivity {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
  lead?: { id: string; companyName: string } | null;
}

export interface CampaignActivityPage {
  activities: CampaignActivity[];
  total: number;
  page: number;
  pageSize: number;
}

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
  autoEnrollGroup?: { id: string; name: string } | null;
  campaignLeads?: CampaignLeadEntry[];
}
