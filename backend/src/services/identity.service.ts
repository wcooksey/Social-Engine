import { prisma } from '../config/database';

/**
 * Sender identity — who a given piece of outreach presents as.
 *
 * One account often works several employees or several services it sells. Each
 * of those is described by a playbook, so the identity lives on the playbook
 * rather than the organization. Resolution is deterministic (see
 * `resolveSenderIdentity`), never left to the model, so the From header and the
 * message body can't drift apart.
 */
export interface SenderIdentity {
  /** Business/brand to present as. Always set — falls back to the org name. */
  orgName: string;
  /** Person the outreach comes from, when a playbook names one. */
  personName?: string;
  title?: string;
  /** From/Reply-To address; only set when it sits on the sending domain. */
  email?: string;
  signature?: string;
  /** Playbook that supplied it — absent when this is the org default. */
  playbookId?: string;
  playbookName?: string;
}

export type IdentityChannel = 'EMAIL' | 'SMS' | 'VOICE';

/** The lead being contacted, as much of it as scope matching needs. */
export interface IdentityLead {
  id: string;
  groupId: string | null;
  status: string;
}

/** Display name for the From header: "Dana Reeves — Northwind HVAC". */
export function identityFromName(identity: SenderIdentity): string {
  if (identity.personName && identity.personName !== identity.orgName) {
    return `${identity.personName} — ${identity.orgName}`;
  }
  return identity.personName || identity.orgName;
}

/** How the sender introduces themselves in prose: "Dana, Service Manager at X". */
export function identityIntro(identity: SenderIdentity): string {
  const who = identity.personName;
  const role = identity.title ? `, ${identity.title},` : '';
  return who ? `${who}${role} at ${identity.orgName}` : identity.orgName;
}

/** Append a playbook's sign-off to an email body, if it has one. */
export function withSignature(body: string, identity: SenderIdentity): string {
  if (!identity.signature?.trim()) return body;
  if (body.includes(identity.signature.trim())) return body; // model already wrote it
  return `${body.trimEnd()}\n\n${identity.signature.trim()}`;
}

function hasIdentity(p: {
  identityName: string | null;
  identityOrgName: string | null;
  identityTitle: string | null;
  identityEmail: string | null;
  identitySignature: string | null;
}): boolean {
  return !!(
    p.identityName ||
    p.identityOrgName ||
    p.identityTitle ||
    p.identityEmail ||
    p.identitySignature
  );
}

/**
 * Pick the identity for outreach to `lead` on `channel`.
 *
 * Among active playbooks that carry an identity and whose scope matches the
 * lead, a scoped playbook (group / campaign / status) beats a GLOBAL one, then
 * the lowest priority number wins, then the oldest. The winning playbook is
 * used whole — its blank fields fall back to the organization, they are not
 * filled in from a runner-up. With no match at all, the org name is the
 * identity, which is exactly how the platform behaved before playbooks could
 * carry one.
 *
 * `mailgunDomain` gates `identityEmail`: an address off the sending domain
 * would be rejected by Mailgun (or land in spam), so it is dropped.
 */
export async function resolveSenderIdentity(
  organizationId: string,
  opts: {
    lead?: IdentityLead | null;
    channel?: IdentityChannel;
    mailgunDomain?: string;
  } = {}
): Promise<SenderIdentity> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const fallback: SenderIdentity = { orgName: org?.name || 'our company' };

  const playbooks = await prisma.playbook.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  const withIdentity = playbooks.filter(hasIdentity);
  if (withIdentity.length === 0) return fallback;

  // Campaign-scoped playbooks need to know what this lead is enrolled in.
  const campaignIds = opts.lead
    ? (
        await prisma.campaignLead.findMany({
          where: { leadId: opts.lead.id },
          select: { campaignId: true },
        })
      ).map((cl) => cl.campaignId)
    : [];

  const matches = withIdentity.filter((p) => {
    if (opts.channel && p.channel !== 'ALL' && p.channel !== opts.channel) return false;
    if (p.scope === 'GLOBAL') return true;
    if (!opts.lead) return false; // no lead in hand — only a global identity applies
    if (p.scope === 'GROUP') return !!p.groupId && p.groupId === opts.lead.groupId;
    if (p.scope === 'CAMPAIGN') return !!p.campaignId && campaignIds.includes(p.campaignId);
    if (p.scope === 'LEAD_STATUS') return !!p.leadStatus && p.leadStatus === opts.lead.status;
    return false;
  });
  if (matches.length === 0) return fallback;

  // Specific beats global; the findMany order already handles priority/age.
  const winner = matches.find((p) => p.scope !== 'GLOBAL') ?? matches[0];

  const email = winner.identityEmail?.trim().toLowerCase();
  const domain = opts.mailgunDomain?.trim().toLowerCase();
  const usableEmail = email && domain && email.endsWith(`@${domain}`) ? email : undefined;

  return {
    orgName: winner.identityOrgName?.trim() || fallback.orgName,
    personName: winner.identityName?.trim() || undefined,
    title: winner.identityTitle?.trim() || undefined,
    email: usableEmail,
    signature: winner.identitySignature?.trim() || undefined,
    playbookId: winner.id,
    playbookName: winner.name,
  };
}
