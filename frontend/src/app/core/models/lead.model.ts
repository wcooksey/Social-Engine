export type LeadStatus =
  | 'NEW'
  | 'RESEARCHING'
  | 'CONTACTED'
  | 'ENGAGED'
  | 'INTERESTED'
  | 'NOT_INTERESTED'
  | 'CUSTOMER'
  | 'ARCHIVED';

export interface LeadGroup {
  id: string;
  name: string;
  goal: string;
  aiSummary?: string | null;
  leadCount: number;
  createdAt: string;
}

export interface Contact {
  id: string;
  leadId: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt: string;
}

export interface Activity {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
  leadId?: string;
  campaignId?: string;
}

export interface Lead {
  id: string;
  companyName: string;
  website?: string | null;
  domain?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  industry?: string | null;
  status: LeadStatus;
  source?: string | null;
  aiSummary?: string | null;
  socials?: Record<string, string> | null;
  group?: LeadGroup | null;
  contacts?: Contact[];
  activities?: Activity[];
  createdAt: string;
}

export interface LeadsQuery {
  search?: string;
  status?: string;
  groupId?: string;
  page?: number;
  pageSize?: number;
}

export interface LeadsPage {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
}
