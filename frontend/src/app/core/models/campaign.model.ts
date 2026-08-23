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

/** One upcoming touch, as shown on the campaign schedule. */
export interface ScheduledTouch {
  id: string;
  leadId: string;
  companyName: string;
  city?: string | null;
  leadStatus: string;
  sequenceStatus: CampaignLeadStatus;
  touchCount: number;
  cycle: number;
  nextTouchAt?: string | null;
  lastTouchAt?: string | null;
  /** Set when this touch will be skipped, and why. */
  blocked?: string | null;
}

/** The angle a repeat pass leads with, so it isn't the same sequence again. */
export interface CampaignCycle {
  id: string;
  cycle: number;
  angle: string;
}

export interface CampaignSchedule {
  days: number;
  reEngageAfterDays: number | null;
  maxCycles: number;
  followUpCadenceDays: number;
  maxTouches: number;
  dormantCount: number;
  cycles: CampaignCycle[];
  upcoming: ScheduledTouch[];
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
  reEngageAfterDays?: number | null;
  maxCycles?: number;
  leadCount: number;
  createdAt: string;
  autoEnrollGroup?: { id: string; name: string } | null;
  campaignLeads?: CampaignLeadEntry[];
}
