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

/**
 * The groups list plus the leads that belong to none of them.
 *
 * Deleting a group unlinks its leads rather than destroying them, so the
 * orphan count has to travel with the list — otherwise those leads are absent
 * from every group view while still sitting in every total.
 */
export interface LeadGroupList {
  groups: LeadGroup[];
  ungroupedLeads: number;
}

/** Sentinel groupId for "belongs to no group" — understood by the leads API. */
export const UNGROUPED_ID = 'none';

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
  /**
   * Street address. Google Places fills this with a full formatted line
   * ("4102 N 40th St, Tampa, FL 33610, USA"); imported or hand-entered leads
   * often carry only the street here with city/state in their own fields.
   */
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
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

/**
 * The lead's full address on one line.
 *
 * The two sources disagree about what `address` holds. Google Places writes a
 * complete formatted line that already contains the city, state and postcode;
 * a CSV import or a hand-entered lead usually puts only the street there and
 * fills city/state/postalCode separately. Appending those unconditionally would
 * print "Tampa, FL" twice on every sourced lead, so each part is added only
 * when the street line doesn't already carry it.
 *
 * Matching is per comma-separated segment rather than a substring test: a
 * street called "Flagler Ave" contains "fl", and a naive `includes` would
 * swallow the state of every lead on it.
 */
export function formatLeadAddress(lead: Lead): string {
  const street = (lead.address || '').trim();
  const segments = street.split(',').map((s) => s.trim().toLowerCase());

  const alreadyPresent = (value?: string | null): boolean => {
    const needle = (value || '').trim().toLowerCase();
    if (!needle) return true; // nothing to add
    return segments.some(
      (seg) => seg === needle || seg.startsWith(`${needle} `) || seg.endsWith(` ${needle}`)
    );
  };

  const city = alreadyPresent(lead.city) ? '' : (lead.city || '').trim();
  const state = alreadyPresent(lead.state) ? '' : (lead.state || '').trim();
  const postal = alreadyPresent(lead.postalCode) ? '' : (lead.postalCode || '').trim();

  // "FL 33610", not "FL, 33610" — a comma between state and postcode is not how
  // a US address is written, and this line gets read off to carriers.
  const region = [state, postal].filter(Boolean).join(' ');
  return [street, city, region].filter(Boolean).join(', ');
}
