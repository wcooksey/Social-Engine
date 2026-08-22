export type DomainPurpose = 'COLD_OUTREACH' | 'TRANSACTIONAL';
export type EmailDomainStatus = 'PENDING' | 'WARMING' | 'ACTIVE' | 'PAUSED' | 'RETIRED';
export type MailboxStatus = 'WARMING' | 'ACTIVE' | 'PAUSED' | 'RETIRED';

/** Rolling 7-day deliverability for one mailbox. */
export interface MailboxHealth {
  sent: number;
  bounced: number;
  complained: number;
  replied: number;
  bounceRate: number;
  complaintRate: number;
  replyRate: number;
  /** Set when the numbers are bad enough that sending must stop. */
  breach: string | null;
}

export interface Mailbox {
  id: string;
  address: string;
  displayName: string | null;
  status: MailboxStatus;
  warmupStartedAt: string | null;
  dailyCapMax: number;
  /** What the warm-up ramp permits today, and what is left of it. */
  allowanceToday: number;
  remainingToday: number;
  sentLastHour: number;
  hourlyCap: number;
  rampHalted: boolean;
  nextSendAt: string;
  pausedReason: string | null;
  pausedUntil: string | null;
  lastSendAt: string | null;
  today: { sent: number; delivered: number; bounced: number; complained: number; replied: number };
  health: MailboxHealth | null;
}

export interface SendingDomain {
  id: string;
  domain: string;
  purpose: DomainPurpose;
  status: EmailDomainStatus;
  dns: {
    spf: boolean | null;
    dkim: boolean | null;
    mx: boolean | null;
    tracking: boolean | null;
    lastCheckedAt: string | null;
  };
  pausedReason: string | null;
  firstSendAt: string | null;
  mailboxes: Mailbox[];
}

export interface SendingOverview {
  /** True while the org still relies on the single MAILGUN_DOMAIN setting. */
  usingLegacySettings: boolean;
  legacyDomain: string | null;
  domains: SendingDomain[];
}

export interface SenderPool {
  id: string;
  name: string;
  createdAt: string;
  mailboxes: { mailbox: { id: string; address: string; status: MailboxStatus } }[];
  _count: { playbooks: number };
}
