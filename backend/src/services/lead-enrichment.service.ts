import { Prisma, EnrichmentTier } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Lead enrichment scoring & triage.
 *
 * The problem this solves: a group holds hundreds of sourced businesses, and
 * from the outside they all look the same. Which ones have an email? How many?
 * Which have a decision maker vs. just a switchboard number? Which are still
 * dead ends worth another research pass, and — critically — which are already
 * good enough that re-running enrichment on them is wasted time and money?
 *
 * Every lead therefore carries a denormalized quality snapshot (score, tier,
 * counts, gaps) recomputed on each lead/contact write, so the whole list can be
 * categorized, filtered and counted in SQL.
 *
 * Retry-with-new-capabilities: leads also carry the capability generation their
 * last enrichment pass ran under. Bump ENRICHMENT_CAPABILITY_VERSION when the
 * platform learns a new enrichment trick and every lead below that version
 * becomes re-workable again — while the leads that are already RICH stay off
 * the work list regardless.
 */

// ---------------------------------------------------------------------------
// Capability generation
// ---------------------------------------------------------------------------

/**
 * Bump this by 1 whenever the platform gains an enrichment capability that
 * could find something the previous generation missed (a new source, a smarter
 * crawl, a new provider). Leads whose `enrichmentVersion` is below this are
 * eligible for a re-run; leads at or above it were already worked with
 * everything we currently have.
 *
 * History:
 *   1 — website crawl + Apollo people search + Mailgun verification
 *   2 — verification actually works (v1 ran against a Mailgun key that lacked
 *       the validation scope, so every check silently failed and NO lead could
 *       earn the verified_email signal), plus find_business_page and
 *       submit_contact_form opened social and contact forms as channels.
 */
export const ENRICHMENT_CAPABILITY_VERSION = 2;

// ---------------------------------------------------------------------------
// Scoring model
// ---------------------------------------------------------------------------

/** Titles that mean "this person can say yes" — not a receptionist. */
const DECISION_MAKER_TITLE_RE =
  /(owner|founder|president|chief|c[eofmt]o|principal|partner|director|manager|head of|\bvp\b|vice president)/i;

/** Contact email states that make an address unusable for outreach. */
const DEAD_EMAIL_STATUSES = new Set(['bounced', 'complained', 'undeliverable']);

export type EnrichmentSignalKey =
  | 'website'
  | 'location'
  | 'company_phone'
  | 'named_contact'
  | 'decision_maker'
  | 'email'
  | 'multiple_emails'
  | 'verified_email'
  | 'direct_phone'
  | 'social';

interface SignalDefinition {
  key: EnrichmentSignalKey;
  weight: number;
  /** Human-readable "what to go find" text, used when reporting gaps. */
  label: string;
  /** Bonus signals aren't reported as gaps — they're upside, not a hole. */
  bonus?: boolean;
}

/** Weights sum to 100. Contactability is worth far more than firmographics. */
export const ENRICHMENT_SIGNALS: SignalDefinition[] = [
  { key: 'email', weight: 25, label: 'an email address for anyone at the company' },
  { key: 'named_contact', weight: 12, label: 'a named person (first + last name)' },
  { key: 'decision_maker', weight: 10, label: 'a decision maker (owner/GM/director-level)' },
  { key: 'verified_email', weight: 10, label: 'a verified-deliverable email' },
  { key: 'direct_phone', weight: 10, label: "a person's direct phone number" },
  { key: 'website', weight: 10, label: 'the company website' },
  { key: 'company_phone', weight: 8, label: 'the main company phone number' },
  { key: 'location', weight: 5, label: 'a city/state or street address' },
  { key: 'social', weight: 5, label: 'a social profile to DM' },
  { key: 'multiple_emails', weight: 5, label: 'a second email (backup contact)', bonus: true },
];

const TOTAL_WEIGHT = ENRICHMENT_SIGNALS.reduce((sum, s) => sum + s.weight, 0);

/** Score thresholds for each tier. Checked high → low. */
const TIER_THRESHOLDS: { tier: EnrichmentTier; min: number }[] = [
  { tier: 'RICH', min: 80 },
  { tier: 'GOOD', min: 60 },
  { tier: 'PARTIAL', min: 35 },
];

export interface ScorableContact {
  firstName: string;
  lastName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  socials?: unknown;
  optedOut?: boolean;
  emailStatus?: string | null;
  emailVerifiedAt?: Date | null;
}

export interface ScorableLead {
  website?: string | null;
  domain?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  socials?: unknown;
}

export interface EnrichmentSnapshot {
  score: number;
  tier: EnrichmentTier;
  emailCount: number;
  phoneCount: number;
  contactCount: number;
  /** Signals we have, for explaining the score. */
  signals: EnrichmentSignalKey[];
  /** Signals we're missing — the agent's shopping list for this lead. */
  gaps: EnrichmentSignalKey[];
}

function hasText(value?: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSocial(socials: unknown): boolean {
  if (!socials || typeof socials !== 'object') return false;
  return Object.values(socials as Record<string, unknown>).some((v) => hasText(typeof v === 'string' ? v : null));
}

/** An address we may not use (opted out) is not an asset — it can't be reached. */
function emailUsable(contact: ScorableContact): boolean {
  if (!hasText(contact.email) || contact.optedOut) return false;
  return !DEAD_EMAIL_STATUSES.has((contact.emailStatus || '').toLowerCase());
}

/**
 * The scoring function — pure, so the same math backs the API, the engine tools,
 * and the migration backfill.
 */
export function scoreLead(lead: ScorableLead, contacts: ScorableContact[]): EnrichmentSnapshot {
  const usableEmails = contacts.filter(emailUsable);
  const emailCount = new Set(usableEmails.map((c) => c.email!.toLowerCase().trim())).size;
  const directPhones = contacts.filter((c) => hasText(c.phone) && !c.optedOut);
  const phoneCount = directPhones.length + (hasText(lead.phone) ? 1 : 0);

  const present: Record<EnrichmentSignalKey, boolean> = {
    website: hasText(lead.website) || hasText(lead.domain),
    location: hasText(lead.city) || hasText(lead.state) || hasText(lead.address),
    company_phone: hasText(lead.phone),
    named_contact: contacts.some((c) => !c.optedOut && hasText(c.firstName) && hasText(c.lastName)),
    decision_maker: contacts.some((c) => !c.optedOut && hasText(c.title) && DECISION_MAKER_TITLE_RE.test(c.title!)),
    email: emailCount >= 1,
    multiple_emails: emailCount >= 2,
    verified_email: usableEmails.some((c) => !!c.emailVerifiedAt),
    direct_phone: directPhones.length >= 1,
    social: hasSocial(lead.socials) || contacts.some((c) => !c.optedOut && hasSocial(c.socials)),
  };

  let score = 0;
  const signals: EnrichmentSignalKey[] = [];
  const gaps: EnrichmentSignalKey[] = [];
  for (const signal of ENRICHMENT_SIGNALS) {
    if (present[signal.key]) {
      score += signal.weight;
      signals.push(signal.key);
    } else if (!signal.bonus) {
      gaps.push(signal.key);
    }
  }
  score = Math.round((score / TOTAL_WEIGHT) * 100);

  return { score, tier: tierFor(score, present), emailCount, phoneCount, contactCount: contacts.length, signals, gaps };
}

function tierFor(score: number, present: Record<EnrichmentSignalKey, boolean>): EnrichmentTier {
  // Reachability is a hard gate, not a score: a lead with a great website and
  // no way to contact anyone is NONE no matter how many points it collected.
  const reachable = present.email || present.company_phone || present.direct_phone || present.social;
  if (!reachable) return 'NONE';
  // Likewise, "we only have the switchboard" never grades above MINIMAL —
  // no named person means no personalized outreach.
  if (!present.named_contact && !present.email) return 'MINIMAL';
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (score >= min) return tier;
  }
  return 'MINIMAL';
}

/** Human-readable "go find this" list for an agent or the UI. */
export function describeGaps(gaps: EnrichmentSignalKey[]): string[] {
  const byKey = new Map(ENRICHMENT_SIGNALS.map((s) => [s.key, s.label]));
  return gaps.map((g) => byKey.get(g) || g);
}

export const ENRICHMENT_TIER_ORDER: EnrichmentTier[] = ['NONE', 'MINIMAL', 'PARTIAL', 'GOOD', 'RICH'];

/** Every tier at or below the given one — "show me everything weaker than GOOD". */
export function tiersUpTo(tier: EnrichmentTier): EnrichmentTier[] {
  const index = ENRICHMENT_TIER_ORDER.indexOf(tier);
  return index < 0 ? ENRICHMENT_TIER_ORDER : ENRICHMENT_TIER_ORDER.slice(0, index + 1);
}

/** Every tier at or above the given one — "only leads good enough to work". */
export function tiersFrom(tier: EnrichmentTier): EnrichmentTier[] {
  const index = ENRICHMENT_TIER_ORDER.indexOf(tier);
  return index < 0 ? ENRICHMENT_TIER_ORDER : ENRICHMENT_TIER_ORDER.slice(index);
}

// ---------------------------------------------------------------------------
// Recompute (keeps the denormalized columns honest)
// ---------------------------------------------------------------------------

/**
 * Recompute one lead's enrichment snapshot. Call after ANY write that could
 * change reachability (lead fields, contact added/edited/removed, an address
 * suppressed by verification or a bounce).
 *
 * Never throws — a stale score must never break the write that triggered it.
 */
export async function recomputeLeadEnrichment(leadId: string): Promise<EnrichmentSnapshot | null> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        website: true,
        domain: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        socials: true,
        contacts: {
          select: {
            firstName: true,
            lastName: true,
            title: true,
            email: true,
            phone: true,
            socials: true,
            optedOut: true,
            emailStatus: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
    if (!lead) return null;

    const snapshot = scoreLead(lead, lead.contacts);
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        enrichmentScore: snapshot.score,
        enrichmentTier: snapshot.tier,
        emailCount: snapshot.emailCount,
        phoneCount: snapshot.phoneCount,
        contactCount: snapshot.contactCount,
        enrichmentGaps: snapshot.gaps as Prisma.InputJsonValue,
      },
    });
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Backfill/repair scores in bulk (whole org, or one group). Used by the
 * recompute endpoint and safe to re-run — it only writes derived columns.
 */
export async function recomputeOrganizationEnrichment(
  organizationId: string,
  options: { groupId?: string; leadIds?: string[] } = {}
): Promise<{ leads: number; tiers: Record<string, number> }> {
  const where: Prisma.LeadWhereInput = {
    organizationId,
    ...(options.groupId ? { groupId: options.groupId } : {}),
    ...(options.leadIds?.length ? { id: { in: options.leadIds } } : {}),
  };

  const tiers: Record<string, number> = {};
  let processed = 0;
  const batchSize = 200;
  let cursor: string | undefined;

  // Cursor-paged so a 100k-lead org doesn't load into memory at once.
  for (;;) {
    const batch = await prisma.lead.findMany({
      where,
      select: {
        id: true,
        website: true,
        domain: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        socials: true,
        contacts: {
          select: {
            firstName: true,
            lastName: true,
            title: true,
            email: true,
            phone: true,
            socials: true,
            optedOut: true,
            emailStatus: true,
            emailVerifiedAt: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;

    for (const lead of batch) {
      const snapshot = scoreLead(lead, lead.contacts);
      tiers[snapshot.tier] = (tiers[snapshot.tier] || 0) + 1;
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          enrichmentScore: snapshot.score,
          enrichmentTier: snapshot.tier,
          emailCount: snapshot.emailCount,
          phoneCount: snapshot.phoneCount,
          contactCount: snapshot.contactCount,
          enrichmentGaps: snapshot.gaps as Prisma.InputJsonValue,
        },
      });
      processed++;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return { leads: processed, tiers };
}

// ---------------------------------------------------------------------------
// Breakdown / stats
// ---------------------------------------------------------------------------

export interface EnrichmentStats {
  totalLeads: number;
  averageScore: number;
  /** Lead counts per tier — the headline categorization. */
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
  /** Most common missing signals, worst first — what to go work on. */
  topGaps: { gap: EnrichmentSignalKey; label: string; leads: number }[];
  retryability: {
    /** Never touched by an enrichment pass. */
    neverAttempted: number;
    /** Worked, but under an older capability generation — worth a retry. */
    staleCapability: number;
    /** Already GOOD/RICH — do not spend time or API credits here. */
    wellEnriched: number;
    /** Weak AND already worked with the current tools — needs a new capability, not another pass. */
    exhausted: number;
    currentCapabilityVersion: number;
  };
}

const EMPTY_TIERS: Record<EnrichmentTier, number> = {
  NONE: 0,
  MINIMAL: 0,
  PARTIAL: 0,
  GOOD: 0,
  RICH: 0,
};

export async function getEnrichmentStats(
  organizationId: string,
  options: { groupId?: string; status?: string } = {}
): Promise<EnrichmentStats> {
  const where: Prisma.LeadWhereInput = {
    organizationId,
    ...(options.groupId ? { groupId: options.groupId } : {}),
    ...(options.status ? { status: options.status as never } : {}),
  };

  const [byTier, aggregate, withEmail, withMultipleEmails, withPhone, noChannel, doNotContact, neverAttempted, staleCapability, wellEnriched] =
    await Promise.all([
      prisma.lead.groupBy({ by: ['enrichmentTier'], where, _count: { _all: true } }),
      prisma.lead.aggregate({ where, _count: { _all: true }, _avg: { enrichmentScore: true } }),
      prisma.lead.count({ where: { ...where, emailCount: { gt: 0 } } }),
      prisma.lead.count({ where: { ...where, emailCount: { gt: 1 } } }),
      prisma.lead.count({ where: { ...where, phoneCount: { gt: 0 } } }),
      prisma.lead.count({ where: { ...where, enrichmentTier: 'NONE' } }),
      prisma.lead.count({ where: { ...where, doNotContact: true } }),
      prisma.lead.count({ where: { ...where, enrichmentAttempts: 0 } }),
      prisma.lead.count({
        where: {
          ...where,
          enrichmentAttempts: { gt: 0 },
          enrichmentVersion: { lt: ENRICHMENT_CAPABILITY_VERSION },
        },
      }),
      prisma.lead.count({ where: { ...where, enrichmentTier: { in: ['GOOD', 'RICH'] } } }),
    ]);

  const total = aggregate._count._all;
  const tiers = { ...EMPTY_TIERS };
  for (const row of byTier) tiers[row.enrichmentTier] = row._count._all;

  const exhausted = await prisma.lead.count({
    where: {
      ...where,
      enrichmentTier: { in: ['NONE', 'MINIMAL', 'PARTIAL'] },
      enrichmentAttempts: { gt: 0 },
      enrichmentVersion: { gte: ENRICHMENT_CAPABILITY_VERSION },
    },
  });

  return {
    totalLeads: total,
    averageScore: Math.round(aggregate._avg.enrichmentScore || 0),
    tiers,
    contactability: {
      withEmail,
      withMultipleEmails,
      withoutEmail: total - withEmail,
      withPhone,
      withoutPhone: total - withPhone,
      withNoChannelAtAll: noChannel,
      doNotContact,
    },
    topGaps: await topGaps(where),
    retryability: {
      neverAttempted,
      staleCapability,
      wellEnriched,
      exhausted,
      currentCapabilityVersion: ENRICHMENT_CAPABILITY_VERSION,
    },
  };
}

/**
 * Count how many leads are missing each signal. `enrichmentGaps` is a JSON
 * array, so this counts via the same predicates the scorer uses rather than
 * unnesting JSON — cheap, indexed, and it can't drift out of sync.
 */
async function topGaps(where: Prisma.LeadWhereInput): Promise<{ gap: EnrichmentSignalKey; label: string; leads: number }[]> {
  const predicates: { gap: EnrichmentSignalKey; where: Prisma.LeadWhereInput }[] = [
    { gap: 'email', where: { emailCount: 0 } },
    { gap: 'company_phone', where: { phone: null } },
    { gap: 'direct_phone', where: { phoneCount: 0 } },
    { gap: 'named_contact', where: { contactCount: 0 } },
    { gap: 'website', where: { AND: [{ website: null }, { domain: null }] } },
  ];
  const counts = await Promise.all(
    predicates.map((p) => prisma.lead.count({ where: { ...where, ...p.where } }))
  );
  const byKey = new Map(ENRICHMENT_SIGNALS.map((s) => [s.key, s.label]));
  return predicates
    .map((p, i) => ({ gap: p.gap, label: byKey.get(p.gap) || p.gap, leads: counts[i] }))
    .filter((row) => row.leads > 0)
    .sort((a, b) => b.leads - a.leads);
}

// ---------------------------------------------------------------------------
// Triage: which leads are worth (re-)enriching
// ---------------------------------------------------------------------------

export interface EnrichmentTargetOptions {
  groupId?: string;
  /** Only leads at or below this tier. Default GOOD is excluded (PARTIAL and down). */
  maxTier?: EnrichmentTier;
  limit?: number;
  /** Skip leads attempted within this many hours (default 24). 0 disables. */
  cooldownHours?: number;
  /**
   * When true (default), leads already worked at the current capability version
   * are skipped — they were tried with everything we have. Set false to force a
   * full re-sweep.
   */
  skipCurrentCapability?: boolean;
}

export interface EnrichmentTarget {
  leadId: string;
  companyName: string;
  website: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  tier: EnrichmentTier;
  score: number;
  emailCount: number;
  phoneCount: number;
  contactCount: number;
  needs: string[];
  attempts: number;
  lastAttemptAt: string | null;
  enrichmentVersion: number;
}

/**
 * The work list: leads that are weak AND actually worth another pass. Ordered
 * worst-first so a limited run spends its budget where it moves the needle, and
 * excludes do-not-contact leads (no point enriching someone we may never
 * contact) plus anything already worked with the current toolset.
 */
export async function findEnrichmentTargets(
  organizationId: string,
  options: EnrichmentTargetOptions = {}
): Promise<{ targets: EnrichmentTarget[]; total: number; capabilityVersion: number }> {
  const limit = Math.min(Math.max(options.limit || 25, 1), 200);
  const cooldownHours = options.cooldownHours ?? 24;
  const skipCurrent = options.skipCurrentCapability ?? true;

  const where: Prisma.LeadWhereInput = {
    organizationId,
    doNotContact: false,
    status: { notIn: ['NOT_INTERESTED', 'ARCHIVED', 'CUSTOMER'] },
    enrichmentTier: { in: tiersUpTo(options.maxTier || 'PARTIAL') },
    ...(options.groupId ? { groupId: options.groupId } : {}),
    ...(skipCurrent ? { enrichmentVersion: { lt: ENRICHMENT_CAPABILITY_VERSION } } : {}),
    ...(cooldownHours > 0
      ? {
          OR: [
            { lastEnrichmentAttemptAt: null },
            { lastEnrichmentAttemptAt: { lt: new Date(Date.now() - cooldownHours * 3600_000) } },
          ],
        }
      : {}),
  };

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: [{ enrichmentScore: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: {
        id: true,
        companyName: true,
        website: true,
        domain: true,
        city: true,
        state: true,
        enrichmentTier: true,
        enrichmentScore: true,
        enrichmentGaps: true,
        emailCount: true,
        phoneCount: true,
        contactCount: true,
        enrichmentAttempts: true,
        lastEnrichmentAttemptAt: true,
        enrichmentVersion: true,
      },
    }),
    prisma.lead.count({ where }),
  ]);

  return {
    capabilityVersion: ENRICHMENT_CAPABILITY_VERSION,
    total,
    targets: leads.map((l) => ({
      leadId: l.id,
      companyName: l.companyName,
      website: l.website,
      domain: l.domain,
      city: l.city,
      state: l.state,
      tier: l.enrichmentTier,
      score: l.enrichmentScore,
      emailCount: l.emailCount,
      phoneCount: l.phoneCount,
      contactCount: l.contactCount,
      needs: describeGaps((Array.isArray(l.enrichmentGaps) ? l.enrichmentGaps : []) as EnrichmentSignalKey[]),
      attempts: l.enrichmentAttempts,
      lastAttemptAt: l.lastEnrichmentAttemptAt?.toISOString() || null,
      enrichmentVersion: l.enrichmentVersion,
    })),
  };
}

/**
 * Record that an enrichment pass ran on a lead, stamping it with the capability
 * generation used. This is what stops the next run from burning time on the
 * same dead ends: a lead worked at the current version drops off the target
 * list until a new capability ships (or the caller forces a re-sweep).
 */
export async function recordEnrichmentAttempt(
  organizationId: string,
  leadId: string,
  outcome: 'improved' | 'no_new_data' | 'blocked'
): Promise<EnrichmentSnapshot & { tierBefore: EnrichmentTier } | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, organizationId },
    select: { id: true, enrichmentTier: true },
  });
  if (!lead) return null;

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      enrichmentAttempts: { increment: 1 },
      lastEnrichmentAttemptAt: new Date(),
      enrichmentVersion: ENRICHMENT_CAPABILITY_VERSION,
      ...(outcome === 'improved' ? { lastEnrichedAt: new Date() } : {}),
    },
  });

  // Re-score after the attempt so the caller sees the tier it actually landed on.
  const snapshot = await recomputeLeadEnrichment(lead.id);
  return snapshot ? { ...snapshot, tierBefore: lead.enrichmentTier } : null;
}
