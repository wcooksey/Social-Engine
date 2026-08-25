import { prisma } from '../config/database';
import { knownAddresses } from './sender.service';

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
  /** From/Reply-To address; only set when it is an address we can send as. */
  email?: string;
  signature?: string;
  /** Physical postal address for the footer (CAN-SPAM). */
  postalAddress?: string;
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

/**
 * The From name for a send, given the mailbox actually chosen to carry it.
 *
 * A mailbox's display name wins over the playbook's person, because the mailbox
 * is the thing the recipient can check: mail leaving mike@ must say Mike. The
 * playbook picks a preferred address but the resolver treats that as a
 * preference — when Mike's mailbox is out of warm-up allowance the send falls
 * through to another address in the pool, and taking the name from the playbook
 * there produces `"Mike — Dealegent" <will@...>`, a name that does not match the
 * address it came from. That is what phishing looks like to a filter and to a
 * person.
 *
 * The playbook still supplies the brand and remains the whole answer for a
 * mailbox with no display name set, which is every mailbox today.
 */
export function fromNameFor(
  identity: SenderIdentity,
  mailboxDisplayName?: string | null
): string {
  const person = mailboxDisplayName?.trim() || identity.personName;
  if (person && person !== identity.orgName) return `${person} — ${identity.orgName}`;
  return person || identity.orgName;
}

/** How the sender introduces themselves in prose: "Dana, Service Manager at X". */
export function identityIntro(identity: SenderIdentity): string {
  const who = identity.personName;
  const role = identity.title ? `, ${identity.title},` : '';
  return who ? `${who}${role} at ${identity.orgName}` : identity.orgName;
}

/**
 * Append a playbook's sign-off and postal footer to an email body.
 *
 * The address is required on commercial mail by CAN-SPAM, and filters read its
 * absence as a spam signal — so it is appended in code rather than left to the
 * model to remember. Either part is skipped if the model already wrote it.
 */
export function withSignature(body: string, identity: SenderIdentity): string {
  let out = body;
  const signature = identity.signature?.trim();
  if (signature && !out.includes(signature)) out = `${out.trimEnd()}\n\n${signature}`;
  const postal = identity.postalAddress?.trim();
  if (postal && !out.includes(postal)) out = `${out.trimEnd()}\n\n${postal}`;
  return out;
}

/**
 * Whether a playbook has an identity it can PRESENT as.
 *
 * Deliberately excludes identityPostalAddress. A postal address is a compliance
 * footer, not a persona: counting it here made a playbook that carries only a
 * regional address a candidate that could out-rank the named one on scope, win,
 * and blank the salesperson's name off the From header — while the body still
 * signed as them. The address is still applied, via `postalAddressFor` below,
 * which is what it was actually for.
 */
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
 * The postal address to put in the footer.
 *
 * Taken from the winning identity when it has one, otherwise from any active
 * playbook that does — the address is a property of the business, not of the
 * persona, so a second playbook carrying it should still satisfy CAN-SPAM
 * rather than being ignored because it lost a persona contest it was never
 * entered in.
 */
function postalAddressFor(
  winner: { identityPostalAddress: string | null } | null,
  all: { identityPostalAddress: string | null }[],
  orgPostalAddress?: string | null
): string | undefined {
  const own = winner?.identityPostalAddress?.trim();
  if (own) return own;
  const fromAnyPlaybook = all.map((p) => p.identityPostalAddress?.trim()).find(Boolean);
  if (fromAnyPlaybook) return fromAnyPlaybook;
  return orgPostalAddress?.trim() || undefined;
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
 * `identityEmail` is gated by what we can actually send as — see
 * `usableSenderAddress`. An address we do not own would be rejected by the
 * provider, or land in spam, so it is dropped rather than passed on.
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
    select: { name: true, postalAddress: true },
  });
  const fallback: SenderIdentity = { orgName: org?.name || 'our company' };

  const playbooks = await prisma.playbook.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  const withIdentity = playbooks.filter(hasIdentity);
  if (withIdentity.length === 0) {
    // No persona anywhere, but the footer is still owed.
    return { ...fallback, postalAddress: postalAddressFor(null, playbooks, org?.postalAddress) };
  }

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
  if (matches.length === 0) return { ...fallback, postalAddress: postalAddressFor(null, playbooks, org?.postalAddress) };

  // Specific beats global; the findMany order already handles priority/age.
  const winner = matches.find((p) => p.scope !== 'GLOBAL') ?? matches[0];

  const usableEmail = await usableSenderAddress(
    organizationId,
    winner.identityEmail,
    opts.mailgunDomain
  );

  return {
    orgName: winner.identityOrgName?.trim() || fallback.orgName,
    personName: winner.identityName?.trim() || undefined,
    title: winner.identityTitle?.trim() || undefined,
    email: usableEmail,
    signature: winner.identitySignature?.trim() || undefined,
    postalAddress: postalAddressFor(winner, playbooks, org?.postalAddress),
    playbookId: winner.id,
    playbookName: winner.name,
  };
}

/**
 * Whether a playbook's identity address is one this organization can send as.
 *
 * A registered mailbox always qualifies. Organizations that have not adopted the
 * mailbox tables yet fall back to the old rule — anything on the single Mailgun
 * domain — so their personas keep working untouched.
 *
 * Once mailboxes exist they are the whole answer: an address that has no mailbox
 * cannot be selected by the sender resolver, so reporting it as the identity
 * would promise a From header that the send would not honour. The fix is to add
 * the mailbox, not to loosen this.
 */
async function usableSenderAddress(
  organizationId: string,
  identityEmail: string | null,
  mailgunDomain?: string
): Promise<string | undefined> {
  const email = identityEmail?.trim().toLowerCase();
  if (!email) return undefined;

  const addresses = await knownAddresses(organizationId);
  if (addresses.has(email)) return email;
  if (addresses.size > 0) return undefined;

  const domain = mailgunDomain?.trim().toLowerCase();
  return domain && email.endsWith(`@${domain}`) ? email : undefined;
}
