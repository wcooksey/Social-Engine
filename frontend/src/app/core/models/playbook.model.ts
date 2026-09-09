export type PlaybookScope = 'GLOBAL' | 'GROUP' | 'CAMPAIGN' | 'LEAD_STATUS';
export type PlaybookChannel = 'ALL' | 'EMAIL' | 'SMS' | 'VOICE';

/**
 * Which system carries this playbook's email. MAILGUN spreads sends across the
 * org's registered domains with warm-up pacing; GMAIL sends from one connected
 * inbox as its owner, with replies landing there.
 */
export type EmailTransport = 'MAILGUN' | 'GMAIL';

export interface Playbook {
  id: string;
  name: string;
  scope: PlaybookScope;
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  campaignId?: string | null;
  campaign?: { id: string; name: string } | null;
  leadStatus?: string | null;
  channel: PlaybookChannel;
  instructions: string;
  isActive: boolean;
  priority: number;
  createdAt: string;
  /** Engine conversations filed under this playbook. */
  _count?: { engineChats: number };

  // Sender identity — who outreach under this playbook presents as. All
  // optional; blank falls back to the organization.
  identityName?: string | null;
  identityOrgName?: string | null;
  identityTitle?: string | null;
  identityEmail?: string | null;
  identitySignature?: string | null;
  /** Overrides the organization's mailing address in the email footer. */
  identityPostalAddress?: string | null;

  // Where this playbook's email actually leaves from.
  emailTransport: EmailTransport;
  senderPoolId?: string | null;
  senderPool?: { id: string; name: string } | null;
  gmailAccountId?: string | null;
  gmailAccount?: { id: string; emailAddress: string; status: string } | null;
}

/** True when a playbook overrides any part of the sender identity. */
export function hasIdentity(playbook: Playbook): boolean {
  return !!(
    playbook.identityName ||
    playbook.identityOrgName ||
    playbook.identityTitle ||
    playbook.identityEmail ||
    playbook.identitySignature ||
    playbook.identityPostalAddress
  );
}

export interface PlaybookReadiness {
  mailboxHealth: { address: string; feedbackObserved: boolean; lastEventAt: string | null; health: { sent: number; bounced: number; complained: number; bounceRate: number; complaintRate: number } | null }[];
  name: string; checkedAt: string; status: string; warmup: string;
  checks: { key: string; state: string; detail: string; href: string }[];
  audience: { total: number; assessed: number; verifiedLeads: number };
  activity: { lastSentAt: string | null; queued: number; drafts: number };
  domains: { domain: string; status: string; mailboxes: { address: string; status: string; allowanceToday: number; remainingToday: number; warmupStartedAt: string | null }[] }[];
}
