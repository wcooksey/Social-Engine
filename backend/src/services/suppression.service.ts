import { SuppressionKind } from '@prisma/client';
import { prisma } from '../config/database';
import { normalizePhone } from './lead.service';

/**
 * Standing "never contact this" records for an organization.
 *
 * Opt-out used to live as a flag on the lead and contact rows, so it died with
 * them: delete a lead, or re-source the same business under a different name or
 * website, and it returned with the flag cleared and started receiving mail
 * again. Keying on the contact detail itself means the ban survives whatever
 * happens to the records around it.
 *
 * The row-level flags are still written — they are what the send tools read on
 * the hot path — but this is the durable record, and every send re-checks it.
 */

export type SuppressionSource =
  | 'unsubscribe_link'
  | 'sms_stop'
  | 'spam_complaint'
  | 'hard_bounce'
  | 'voice_optout'
  | 'reply_optout'
  | 'manual';

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

function normalizeDomainValue(value: string): string | null {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return trimmed.includes('.') ? trimmed : null;
}

/** Normalize a value for its kind, or null when it isn't usable as a key. */
export function normalizeSuppressionValue(kind: SuppressionKind, value: string): string | null {
  if (kind === 'EMAIL') return normalizeEmail(value);
  if (kind === 'PHONE') return normalizePhone(value);
  return normalizeDomainValue(value);
}

export interface SuppressInput {
  organizationId: string;
  kind: SuppressionKind;
  value: string;
  reason?: string;
  source?: SuppressionSource;
  originLeadId?: string;
}

/** Record a suppression. Idempotent — re-suppressing keeps the original record. */
export async function suppress(input: SuppressInput): Promise<boolean> {
  const value = normalizeSuppressionValue(input.kind, input.value);
  if (!value) return false;
  await prisma.suppression
    .upsert({
      where: {
        organizationId_kind_value: {
          organizationId: input.organizationId,
          kind: input.kind,
          value,
        },
      },
      create: {
        organizationId: input.organizationId,
        kind: input.kind,
        value,
        reason: input.reason,
        source: input.source,
        originLeadId: input.originLeadId,
      },
      // Keep the first record: the earliest opt-out is the one that matters,
      // and overwriting its reason would lose why the ban exists.
      update: {},
    });
  return true;
}

/**
 * Why this address or number must not be contacted, or null if it may be.
 *
 * An email is checked against both the address and its domain, so a
 * "remove our whole firm" request covers people we have not met yet.
 */
export async function suppressionReason(
  organizationId: string,
  opts: { email?: string | null; phone?: string | null }
): Promise<string | null> {
  const keys: { kind: SuppressionKind; value: string }[] = [];

  if (opts.email) {
    const email = normalizeEmail(opts.email);
    if (email) {
      keys.push({ kind: 'EMAIL', value: email });
      const domain = email.split('@')[1];
      if (domain) keys.push({ kind: 'DOMAIN', value: domain });
    }
  }
  if (opts.phone) {
    const phone = normalizePhone(opts.phone);
    if (phone) keys.push({ kind: 'PHONE', value: phone });
  }
  if (keys.length === 0) return null;

  const hit = await prisma.suppression.findFirst({
    where: { organizationId, OR: keys },
  });
  if (!hit) return null;

  const what =
    hit.kind === 'DOMAIN'
      ? `everyone at ${hit.value}`
      : hit.kind === 'PHONE'
        ? `the number ending ${hit.value.slice(-4)}`
        : hit.value;
  return `${what} is on this organization's suppression list (${hit.reason || hit.source || 'opted out'}, recorded ${hit.createdAt.toISOString().slice(0, 10)}). Do not contact on any channel.`;
}

/**
 * One location opting out does not opt out its siblings.
 *
 * Rooftops of a dealer group are separate legal entities sharing a corporate
 * website, so a stop request from one is not consent withdrawn for the others —
 * but it is a strong signal, and mailing the group's next store the following
 * week lands badly whatever the law says. Siblings are flagged for review
 * rather than suppressed, and an SDR is asked to establish whether they are
 * genuinely independent before anything else goes out.
 */
export async function flagSiblingLocations(
  organizationId: string,
  originLeadId: string,
  reason: string
): Promise<number> {
  const lead = await prisma.lead.findFirst({
    where: { id: originLeadId, organizationId },
    select: { id: true, domain: true, companyName: true },
  });
  if (!lead?.domain) return 0;

  const siblings = await prisma.lead.findMany({
    where: {
      organizationId,
      domain: lead.domain,
      id: { not: lead.id },
      doNotContact: false,
      contactReviewReason: null,
    },
    select: { id: true, companyName: true },
    take: 200,
  });
  if (siblings.length === 0) return 0;

  const note = `A location sharing this website (${lead.companyName}) opted out: ${reason}`;
  await prisma.lead.updateMany({
    where: { id: { in: siblings.map((s) => s.id) } },
    data: { contactReviewReason: note },
  });

  // Hand the judgement to the Engine rather than a person: separate ownership
  // is a researchable fact, and leaving these parked until someone notices
  // would quietly stall a chunk of the pipeline.
  await prisma.agentJob
    .create({
      data: {
        organizationId,
        leadId: lead.id,
        type: 'RESEARCH',
        role: 'RESEARCHER',
        objective:
          `${lead.companyName} asked us to stop contacting them (${reason}). ${siblings.length} other ` +
          `lead(s) share the website ${lead.domain} and are now on hold: ` +
          `${siblings.map((s) => s.companyName).slice(0, 20).join(', ')}.\n\n` +
          'Establish whether those locations are separate businesses or the same legal entity. ' +
          'Check ownership on their websites, corporate registries and any "our locations" page: ' +
          'a dealer group of independently-owned rooftops is not one company, but a chain of ' +
          'branches under one entity is. For each location, call clear_contact_review with your ' +
          'finding — release it only where you have real evidence it is a separate business, and ' +
          'when in doubt leave it on hold and say why. Getting this wrong means contacting someone ' +
          'who told us to stop, so err toward leaving it on hold.',
        runAt: new Date(),
      },
    })
    .catch(() => undefined);

  return siblings.length;
}
