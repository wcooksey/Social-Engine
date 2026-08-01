export type LeadStatus =
  | 'NEW'
  | 'RESEARCHING'
  | 'CONTACTED'
  | 'ENGAGED'
  | 'INTERESTED'
  | 'NOT_INTERESTED'
  | 'CUSTOMER'
  | 'ARCHIVED';

/**
 * How reachable a lead actually is, worst → best. Computed server-side from the
 * lead + its contacts on every write, so a list of hundreds can be categorized
 * instead of eyeballed.
 */
export type EnrichmentTier = 'NONE' | 'MINIMAL' | 'PARTIAL' | 'GOOD' | 'RICH';

export const ENRICHMENT_TIERS: EnrichmentTier[] = ['NONE', 'MINIMAL', 'PARTIAL', 'GOOD', 'RICH'];

export const ENRICHMENT_TIER_LABEL: Record<EnrichmentTier, string> = {
  NONE: 'Unreachable',
  MINIMAL: 'Company only',
  PARTIAL: 'Partial',
  GOOD: 'Good',
  RICH: 'Fully enriched'
};

export const ENRICHMENT_TIER_HINT: Record<EnrichmentTier, string> = {
  NONE: 'No email, phone, or social — needs research before any outreach',
  MINIMAL: 'Main company line or generic inbox only, no named person',
  PARTIAL: 'Some detail, but missing a channel or the decision maker',
  GOOD: 'A named contact with a direct email or phone — ready for outreach',
  RICH: 'Decision maker, verified email, phone and socials — nothing left to find'
};

export interface GroupEnrichment {
  averageScore: number;
  withEmail: number;
  tiers: Record<EnrichmentTier, number>;
}

export interface LeadGroup {
  id: string;
  name: string;
  goal: string;
  aiSummary?: string | null;
  leadCount: number;
  /** Group-scoped playbooks — these are DELETED with the group, not unlinked. */
  playbookCount?: number;
  /** Coverage cells — the sourcing progress record, also deleted with the group. */
  coverageCellCount?: number;
  createdAt: string;
  enrichment?: GroupEnrichment;
}

export interface EnrichmentStats {
  totalLeads: number;
  averageScore: number;
  tiers: Record<EnrichmentTier, number>;
  contactability: {
    withEmail: number;
    withMultipleEmails: number;
    withoutEmail: number;
    withPhone: number;
    withoutPhone: number;
    withNoChannelAtAll: number;
    doNotContact: number;
  };
  topGaps: { gap: string; label: string; leads: number }[];
  retryability: {
    neverAttempted: number;
    staleCapability: number;
    wellEnriched: number;
    exhausted: number;
    currentCapabilityVersion: number;
  };
}

export interface Contact {
  id: string;
  leadId: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  optedOut?: boolean;
  emailStatus?: string | null;
  emailVerifiedAt?: string | null;
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
  contactCount?: number;
  activities?: Activity[];
  createdAt: string;
  doNotContact?: boolean;

  // Enrichment snapshot (denormalized server-side).
  enrichmentScore?: number;
  enrichmentTier?: EnrichmentTier;
  emailCount?: number;
  phoneCount?: number;
  enrichmentGaps?: string[] | null;
  enrichmentVersion?: number;
  enrichmentAttempts?: number;
  lastEnrichedAt?: string | null;
  lastEnrichmentAttemptAt?: string | null;
}

export interface LeadsQuery {
  search?: string;
  status?: string;
  groupId?: string;
  page?: number;
  pageSize?: number;
  /** Comma-separated tiers, e.g. "NONE,MINIMAL". */
  tier?: string;
  maxTier?: EnrichmentTier;
  minTier?: EnrichmentTier;
  hasEmail?: boolean;
  hasPhone?: boolean;
  multipleEmails?: boolean;
  sort?: 'created' | 'score' | 'company' | 'emails';
  sortDir?: 'asc' | 'desc';
}

export interface LeadsPage {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
}
