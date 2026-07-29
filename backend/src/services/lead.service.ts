import { Prisma, EnrichmentTier } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';
import {
  ENRICHMENT_TIER_ORDER,
  recomputeLeadEnrichment,
  tiersFrom,
  tiersUpTo,
} from './lead-enrichment.service';

/** Normalize a website/URL/domain string to a bare dedup key like "sunshinetoyota.com". */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split(/[/?#]/)[0];
  return value.includes('.') ? value : null;
}

export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Re-score a lead after a write and fold the fresh numbers into the object we
 * hand back, so callers never see a stale enrichment snapshot.
 */
async function withFreshEnrichment<T extends { id: string }>(lead: T): Promise<T> {
  const snapshot = await recomputeLeadEnrichment(lead.id);
  if (!snapshot) return lead;
  return {
    ...lead,
    enrichmentScore: snapshot.score,
    enrichmentTier: snapshot.tier,
    emailCount: snapshot.emailCount,
    phoneCount: snapshot.phoneCount,
    contactCount: snapshot.contactCount,
    enrichmentGaps: snapshot.gaps,
  };
}

export interface UpsertLeadInput {
  companyName: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  industry?: string;
  source?: string;
  groupId?: string;
  groupName?: string;
  status?: string;
  aiSummary?: string;
  socials?: Record<string, string>;
}

class LeadService {
  /**
   * Create-or-update with dedup. Match order: normalized domain, then
   * (companyName + city/state), then normalized phone. Used by both the REST
   * API and the Engine's upsert_lead tool so the AI can never create dupes.
   */
  async upsertLead(organizationId: string, input: UpsertLeadInput) {
    if (!input.companyName?.trim()) throw new AppError('companyName is required');

    const domain = normalizeDomain(input.website);
    const phone = normalizePhone(input.phone);

    let groupId = input.groupId ?? null;
    if (!groupId && input.groupName) {
      const group = await prisma.leadGroup.upsert({
        where: { organizationId_name: { organizationId, name: input.groupName.trim() } },
        create: { organizationId, name: input.groupName.trim() },
        update: {},
      });
      groupId = group.id;
    }

    let existing = null;
    if (domain) {
      existing = await prisma.lead.findUnique({
        where: { organizationId_domain: { organizationId, domain } },
      });
    }
    if (!existing) {
      existing = await prisma.lead.findFirst({
        where: {
          organizationId,
          companyName: { equals: input.companyName.trim(), mode: 'insensitive' },
          ...(input.city ? { city: { equals: input.city, mode: 'insensitive' } } : {}),
          ...(input.state ? { state: { equals: input.state, mode: 'insensitive' } } : {}),
        },
      });
    }
    if (!existing && phone) {
      const candidates = await prisma.lead.findMany({
        where: { organizationId, phone: { not: null } },
        select: { id: true, phone: true },
        take: 2000,
      });
      const match = candidates.find((c) => normalizePhone(c.phone) === phone);
      if (match) existing = await prisma.lead.findUnique({ where: { id: match.id } });
    }

    const data = {
      companyName: input.companyName.trim(),
      website: input.website?.trim() || undefined,
      domain: domain || undefined,
      phone: input.phone?.trim() || undefined,
      address: input.address || undefined,
      city: input.city || undefined,
      state: input.state || undefined,
      postalCode: input.postalCode || undefined,
      country: input.country || undefined,
      industry: input.industry || undefined,
      source: input.source || undefined,
      aiSummary: input.aiSummary || undefined,
      socials: input.socials ? (input.socials as Prisma.InputJsonValue) : undefined,
      ...(groupId ? { groupId } : {}),
      ...(input.status ? { status: input.status as never } : {}),
    };

    if (existing) {
      const updated = await prisma.lead.update({ where: { id: existing.id }, data });
      // Website/phone/socials just changed — re-grade how reachable this lead is.
      return { lead: await withFreshEnrichment(updated), created: false };
    }
    const created = await prisma.lead.create({ data: { ...data, organizationId } });
    return { lead: await withFreshEnrichment(created), created: true };
  }

  async searchLeads(
    organizationId: string,
    params: {
      search?: string;
      status?: string;
      groupId?: string;
      state?: string;
      page?: number;
      pageSize?: number;
      // --- Enrichment categorization filters ---
      /** Exact tiers to include, e.g. ['NONE','MINIMAL'] — "show me the weak ones". */
      tiers?: EnrichmentTier[];
      /** Everything at or below a tier (inclusive), e.g. maxTier=PARTIAL. */
      maxTier?: EnrichmentTier;
      /** Everything at or above a tier (inclusive), e.g. minTier=GOOD. */
      minTier?: EnrichmentTier;
      minScore?: number;
      maxScore?: number;
      /** true = has at least one usable email; false = has none. */
      hasEmail?: boolean;
      hasPhone?: boolean;
      /** Only leads with more than one email on file (redundancy). */
      multipleEmails?: boolean;
      sort?: 'created' | 'score' | 'company' | 'emails';
      sortDir?: 'asc' | 'desc';
    }
  ) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 25));

    // Tier filters compose: an explicit list wins, otherwise min/max expand to
    // ranges and intersect when both are given.
    let tierFilter: EnrichmentTier[] | null = params.tiers?.length ? params.tiers : null;
    if (!tierFilter && (params.maxTier || params.minTier)) {
      const below = params.maxTier ? tiersUpTo(params.maxTier) : ENRICHMENT_TIER_ORDER;
      const above = params.minTier ? tiersFrom(params.minTier) : ENRICHMENT_TIER_ORDER;
      tierFilter = below.filter((t) => above.includes(t));
    }

    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.state ? { state: { equals: params.state, mode: 'insensitive' } } : {}),
      ...(tierFilter ? { enrichmentTier: { in: tierFilter } } : {}),
      ...(params.minScore != null || params.maxScore != null
        ? {
            enrichmentScore: {
              ...(params.minScore != null ? { gte: params.minScore } : {}),
              ...(params.maxScore != null ? { lte: params.maxScore } : {}),
            },
          }
        : {}),
      ...(params.hasEmail != null ? { emailCount: params.hasEmail ? { gt: 0 } : 0 } : {}),
      ...(params.multipleEmails ? { emailCount: { gt: 1 } } : {}),
      ...(params.hasPhone != null ? { phoneCount: params.hasPhone ? { gt: 0 } : 0 } : {}),
      ...(params.search
        ? {
            OR: [
              { companyName: { contains: params.search, mode: 'insensitive' } },
              { domain: { contains: params.search.toLowerCase() } },
              { city: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const direction: Prisma.SortOrder = params.sortDir === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.LeadOrderByWithRelationInput[] =
      params.sort === 'score'
        ? [{ enrichmentScore: direction }, { createdAt: 'desc' }]
        : params.sort === 'emails'
          ? [{ emailCount: direction }, { enrichmentScore: 'desc' }]
          : params.sort === 'company'
            ? [{ companyName: params.sortDir === 'desc' ? 'desc' : 'asc' }]
            : [{ createdAt: direction }];

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          group: { select: { id: true, name: true } },
          _count: { select: { contacts: true } },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.lead.count({ where }),
    ]);

    return {
      leads: leads.map((l) => ({ ...l, contactCount: l._count.contacts })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Advance a lead's pipeline status after a touch actually went out.
   *
   * Status used to move ONLY when an agent remembered to call
   * update_lead_status, so a lead marked RESEARCHING at the start of a run sat
   * there forever — including after we had emailed it. Sending is an objective
   * fact, so the transition is mechanical, like campaign cadence.
   *
   * Only ever moves forward out of the two "not yet contacted" states. ENGAGED,
   * INTERESTED, CUSTOMER, NOT_INTERESTED and ARCHIVED are decisions made by a
   * reply or a human, and must never be overwritten by an outbound touch.
   */
  async advanceStatusOnTouch(leadId: string, channelLabel: string, agentRunId?: string): Promise<void> {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, organizationId: true, status: true },
      });
      if (!lead || (lead.status !== 'NEW' && lead.status !== 'RESEARCHING')) return;

      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
      await this.logActivity({
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: 'STATUS_CHANGE',
        summary: `Status changed from ${lead.status} to CONTACTED — ${channelLabel} sent`,
        agentRunId,
      });
    } catch {
      // Never let bookkeeping fail the send that triggered it.
    }
  }

  async logActivity(input: {
    organizationId: string;
    leadId: string;
    type: string;
    summary: string;
    payload?: Record<string, unknown>;
    campaignId?: string;
    agentRunId?: string;
  }) {
    return prisma.activity.create({
      data: {
        organizationId: input.organizationId,
        leadId: input.leadId,
        type: input.type as never,
        summary: input.summary,
        payload: input.payload ? (input.payload as Prisma.InputJsonValue) : undefined,
        campaignId: input.campaignId,
        agentRunId: input.agentRunId,
      },
    });
  }
}

export const leadService = new LeadService();

/** How long a lead may sit in RESEARCHING with nothing happening. */
const STALE_RESEARCHING_HOURS = 24;

/**
 * Release leads stranded in RESEARCHING back to NEW.
 *
 * RESEARCHING means "an agent is working this right now". A run that ends —
 * iterations exhausted, handed to another role, or failed — leaves the flag
 * set with nothing to clear it, and the lead then looks busy forever and is
 * skipped by anything filtering on NEW. Leads that were actually contacted are
 * moved to CONTACTED by advanceStatusOnTouch instead, so anything still sitting
 * here genuinely was never reached.
 */
export async function releaseStaleResearchingLeads(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RESEARCHING_HOURS * 3600_000);

  const stale = await prisma.lead.findMany({
    where: {
      status: 'RESEARCHING',
      // Nothing at all has happened on this lead since the cutoff — no
      // research note, no touch, no status change.
      activities: { none: { createdAt: { gte: cutoff } } },
    },
    select: { id: true, organizationId: true, companyName: true },
    take: 500,
  });
  if (stale.length === 0) return 0;

  await prisma.lead.updateMany({
    where: { id: { in: stale.map((l) => l.id) } },
    data: { status: 'NEW' },
  });
  await prisma.activity.createMany({
    data: stale.map((l) => ({
      organizationId: l.organizationId,
      leadId: l.id,
      type: 'STATUS_CHANGE' as const,
      summary: `Status returned to NEW — sat in RESEARCHING for over ${STALE_RESEARCHING_HOURS}h with no activity, so it is back in the pool.`,
    })),
  });
  return stale.length;
}
