import { Prisma, type EmailDomain, type GmailAccount, type Mailbox } from '@prisma/client';
import { prisma } from '../config/database';
import { decrypt } from '../utils/encryption';
import type { EmailCreds } from './channels.service';
import { mailgunGet, senderAddress } from './channels.service';
import {
  accountForPlaybook,
  anyUsableGmailAccount,
  gmailNextSendAt,
  gmailSentToday,
} from './gmail.service';
import { getOrgConfig } from './settings.service';

/**
 * Sending infrastructure — which domain and which address a given piece of mail
 * actually leaves from.
 *
 * Cold outreach spends sender reputation, so it is spread across purpose-built
 * domains that are expected to wear out, while meeting invites and booking
 * confirmations ride a domain that never sends cold mail. Selection is
 * deterministic and never left to the model: a thread keeps the mailbox it
 * started with, and a paused mailbox is simply not offered.
 *
 * Backwards compatibility: an organization that has not adopted this yet still
 * has its single MAILGUN_DOMAIN setting, and every resolver falls back to it.
 *
 * Two transports live here. Mailgun domains carry volume; a connected Gmail
 * inbox carries the low-volume, hand-researched kind of outreach that is worth
 * sending as a person. Which one a piece of mail uses is decided by the
 * playbook it runs under — never by the model, and never by whichever happens
 * to be configured.
 */

export type SenderPurpose = 'COLD_OUTREACH' | 'TRANSACTIONAL';

/** Which system puts the message on the wire. */
export type SenderTransport = 'mailgun' | 'gmail';

export interface ResolvedSender {
  transport: SenderTransport;
  /** Null on the legacy path and on the Gmail transport. */
  mailboxId: string | null;
  /** The connected inbox, on the Gmail transport. */
  gmailAccountId?: string;
  /** Today's remaining-cap basis, for the caller to reserve against. */
  allowanceToday?: number;
  /** Mailgun credentials. Absent on the Gmail transport, which uses OAuth. */
  creds?: EmailCreds;
  /** Address the mail goes out as. */
  fromEmail: string;
  displayName?: string;
  replyTo?: string;
}

type MailboxWithDomain = Mailbox & { emailDomain: EmailDomain };

/** Mailgun credentials as configured the old way (one domain for everything). */
type LegacyCreds = { apiKey: string; domain: string; fromEmail: string };

// ---------------------------------------------------------------------------
// Warm-up allowance & pacing
// ---------------------------------------------------------------------------

/** Days of ramp to evaluate — past this the cap has long since topped out. */
const MAX_RAMP_DAYS = 365;

/** Rolling window the ramp health gate reads. */
const RAMP_HEALTH_DAYS = 3;
/** Sends needed in that window before its bounce rate means anything. */
const RAMP_HEALTH_MIN_SENDS = 20;
/** Hard-bounce rate that stops the ramp. Well under the ~5% that draws blocks. */
const RAMP_HALT_BOUNCE_RATE = 0.05;

/** Jitter band applied to the spacing between sends: 0.6x to 1.4x. */
const JITTER_MIN = 0.6;
const JITTER_SPREAD = 0.8;

export interface MailboxLoad {
  /** Prior UTC days with actual sends since the current warm-up began. */
  activeSendingDays?: number;
  /** Sends recorded against today's ledger row. */
  sentToday: number;
  /** Outbound messages in the trailing 60 minutes. */
  sentLastHour: number;
  /**
   * When the oldest of those leaves the window and a slot frees up. Null when
   * the window is empty. Without it a mailbox at its hourly cap reports a retry
   * time of "now", and the cadence sweep re-queues the same touch every pass.
   */
  hourlySlotFreesAt: Date | null;
  /** True when recent bounces are bad enough to stop the ramp growing. */
  rampHalted: boolean;
}

const EMPTY_LOAD: MailboxLoad = {
  sentToday: 0,
  sentLastHour: 0,
  hourlySlotFreesAt: null,
  rampHalted: false,
};

/**
 * How many sends this mailbox is allowed today.
 *
 * A WARMING mailbox follows its ramp: it starts at `dailyCapStart` and grows by
 * `warmupGrowthPct` per day since its first real send, up to `dailyCapMax`. An
 * ACTIVE mailbox has finished warming and simply runs at `dailyCapMax` — which
 * is also what keeps an adopted, already-warm domain from being throttled back
 * to a handful of sends a day.
 *
 * When the ramp is halted the allowance drops to the starting cap rather than
 * merely pausing its growth: a mailbox that is bouncing has already been sending
 * more than it has earned.
 */
export function dailyAllowance(
  mailbox: Pick<
    Mailbox,
    'status' | 'dailyCapStart' | 'dailyCapMax' | 'warmupGrowthPct' | 'warmupStartedAt'
  >,
  load: MailboxLoad = EMPTY_LOAD,
  now: Date = new Date()
): number {
  // The halt brake is checked before anything else. An ACTIVE mailbox that
  // starts bouncing has to be throttled too — otherwise finishing the ramp
  // would make a mailbox permanently exempt from the one brake short of a pause.
  if (load.rampHalted) return Math.min(mailbox.dailyCapStart, mailbox.dailyCapMax);
  if (mailbox.status === 'ACTIVE') return mailbox.dailyCapMax;
  if (!mailbox.warmupStartedAt) return Math.min(mailbox.dailyCapStart, mailbox.dailyCapMax);

  const elapsedDays = Math.floor(
    (now.getTime() - mailbox.warmupStartedAt.getTime()) / (24 * 3600 * 1000)
  );
  const days = Math.max(0, Math.min(MAX_RAMP_DAYS, elapsedDays, load.activeSendingDays ?? 0));
  const ramped = Math.round(
    mailbox.dailyCapStart * Math.pow(1 + mailbox.warmupGrowthPct / 100, days)
  );
  return Math.min(mailbox.dailyCapMax, Math.max(mailbox.dailyCapStart, ramped));
}

/**
 * Deterministic jitter in [JITTER_MIN, JITTER_MIN + JITTER_SPREAD).
 *
 * Seeded from the mailbox and its last send so the answer is stable for a given
 * state — the same question asked twice gets the same answer, which a random
 * factor would not give, while the interval still varies from send to send.
 */
function jitterFactor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return JITTER_MIN + (Math.abs(hash) % 1000) / 1000 * JITTER_SPREAD;
}

/**
 * Minimum gap between two sends from one mailbox, spread evenly across the hour
 * its cap allows and then jittered. Without this an hourly cap of 8 is spent in
 * eight seconds, which is the burst pattern filters look for.
 */
export function spacingMs(mailbox: Pick<Mailbox, 'id' | 'hourlyCap' | 'lastSendAt'>): number {
  const perHour = Math.max(1, mailbox.hourlyCap);
  const even = (60 * 60 * 1000) / perHour;
  return Math.round(even * jitterFactor(`${mailbox.id}:${mailbox.lastSendAt?.getTime() ?? 0}`));
}

/** When this mailbox may next send, given its own pacing. */
export function nextSendAt(
  mailbox: Pick<Mailbox, 'id' | 'hourlyCap' | 'lastSendAt'>,
  now: Date = new Date()
): Date {
  if (!mailbox.lastSendAt) return now;
  const ready = new Date(mailbox.lastSendAt.getTime() + spacingMs(mailbox));
  return ready > now ? ready : now;
}

/** Start of the next UTC day — when an exhausted daily allowance resets. */
function nextDayReset(now: Date): Date {
  return new Date(utcDay(now).getTime() + 24 * 3600 * 1000);
}

/**
 * Current load for a set of mailboxes, in a fixed number of queries regardless
 * of how many candidates there are.
 */
export async function loadFor(mailboxIds: string[], now: Date = new Date()): Promise<Map<string, MailboxLoad>> {
  const loads = new Map<string, MailboxLoad>();
  if (mailboxIds.length === 0) return loads;

  const windowStart = new Date(utcDay(now).getTime() - (RAMP_HEALTH_DAYS - 1) * 24 * 3600 * 1000);
  const [stats, hourly, history, mailboxes] = await Promise.all([
    prisma.mailboxDailyStat.findMany({
      where: { mailboxId: { in: mailboxIds }, date: { gte: windowStart } },
    }),
    prisma.message.groupBy({
      by: ['mailboxId'],
      where: {
        mailboxId: { in: mailboxIds },
        direction: 'OUTBOUND',
        sentAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
      },
      _count: { _all: true },
      _min: { sentAt: true },
    }),
    prisma.mailboxDailyStat.findMany({ where: { mailboxId: { in: mailboxIds }, sent: { gt: 0 }, date: { lt: utcDay(now), gte: new Date(now.getTime() - MAX_RAMP_DAYS * 86400000) } }, select: { mailboxId: true, date: true } }),
    prisma.mailbox.findMany({ where: { id: { in: mailboxIds } }, select: { id: true, warmupStartedAt: true } }),
  ]);

  const hourlyById = new Map(
    hourly
      .filter((row) => row.mailboxId)
      .map((row) => [
        row.mailboxId as string,
        { count: row._count._all, oldest: row._min.sentAt as Date | null },
      ])
  );
  const today = utcDay(now).getTime();

  for (const id of mailboxIds) {
    const rows = stats.filter((row) => row.mailboxId === id);
    const sentToday = rows.find((row) => row.date.getTime() === today)?.sent ?? 0;
    const windowSent = rows.reduce((total, row) => total + row.sent, 0);
    const windowBounced = rows.reduce((total, row) => total + row.bounced, 0);
    const hour = hourlyById.get(id);
    const started = mailboxes.find(m => m.id === id)?.warmupStartedAt;
    loads.set(id, {
      activeSendingDays: started ? history.filter(row => row.mailboxId === id && row.date >= utcDay(started)).length : 0,
      sentToday,
      sentLastHour: hour?.count ?? 0,
      hourlySlotFreesAt: hour?.oldest ? new Date(hour.oldest.getTime() + 60 * 60 * 1000) : null,
      rampHalted:
        windowSent >= RAMP_HEALTH_MIN_SENDS &&
        windowBounced / windowSent > RAMP_HALT_BOUNCE_RATE,
    });
  }
  return loads;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Whether a mailbox may be handed out right now.
 *
 * PENDING domains are excluded on purpose: DNS that the provider has not
 * verified means the send is rejected at the API anyway, and a rejected send
 * still looks like a failure on the lead's timeline.
 *
 * This checks identity availability; weigh/reserve apply warm-up and pacing.
 */
export function isMailboxAvailable(mailbox: MailboxWithDomain, now = new Date()): boolean {
  if (mailbox.status === 'PAUSED' || mailbox.status === 'RETIRED') return false;
  if (mailbox.pausedUntil && mailbox.pausedUntil > now) return false;
  const domain = mailbox.emailDomain;
  return domain.spfOk === true && domain.dkimOk === true && (domain.status === 'WARMING' || domain.status === 'ACTIVE');
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function decryptOrNull(payload: string): string | null {
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/**
 * API key for a domain: its own if it carries one, else the organization's.
 * Lets a domain live on a separate provider account without forcing every
 * domain to.
 */
export async function apiKeyForDomain(
  organizationId: string,
  domain: EmailDomain,
  legacy?: LegacyCreds
): Promise<string | null> {
  if (domain.apiKeyEncrypted) {
    const own = decryptOrNull(domain.apiKeyEncrypted);
    if (own) return own;
  }
  const fallback = legacy ?? (await legacyCreds(organizationId));
  return fallback.apiKey || null;
}

async function legacyCreds(organizationId: string): Promise<LegacyCreds> {
  const orgConfig = await getOrgConfig(organizationId);
  return orgConfig.mailgun;
}

/**
 * Sender for an org still on the single-domain setup.
 *
 * A playbook persona address on that domain is honoured: before mailboxes
 * existed it was the From and Reply-To, and ignoring it here would quietly
 * collapse every persona in the org onto one address.
 *
 * The address is always returned bare. MAILGUN_FROM_EMAIL may hold a pasted
 * `Name <addr@x>`, and callers put this straight into places that cannot take
 * a display name — the ORGANIZER line of a calendar invite, for one.
 */
function legacySender(legacy: LegacyCreds, preferAddress?: string | null): ResolvedSender | null {
  if (!legacy.apiKey || !legacy.domain) return null;
  const domain = legacy.domain.trim().toLowerCase();
  const preferred = preferAddress?.trim().toLowerCase();
  if (preferred && preferred.endsWith(`@${domain}`)) {
    return {
      transport: 'mailgun',
      mailboxId: null,
      creds: legacy,
      fromEmail: preferred,
      replyTo: preferred,
    };
  }
  return {
    transport: 'mailgun',
    mailboxId: null,
    creds: legacy,
    fromEmail: senderAddress(legacy),
  };
}

async function senderFromMailbox(
  organizationId: string,
  mailbox: MailboxWithDomain,
  legacy?: LegacyCreds,
  allowanceToday?: number
): Promise<ResolvedSender | null> {
  const apiKey = await apiKeyForDomain(organizationId, mailbox.emailDomain, legacy);
  if (!apiKey) return null;
  return {
    transport: 'mailgun',
    mailboxId: mailbox.id,
    allowanceToday,
    creds: { apiKey, domain: mailbox.emailDomain.domain, fromEmail: mailbox.address },
    fromEmail: mailbox.address,
    displayName: mailbox.displayName ?? undefined,
    replyTo: mailbox.replyTo ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SenderRequest {
  /** Defaults to COLD_OUTREACH — the conservative choice. */
  purpose?: SenderPurpose;
  /** Restricts candidates to this playbook's pool, when it has one. */
  playbookId?: string | null;
  /** Existing thread; its mailbox wins if it is still usable. */
  conversationId?: string | null;
  /** A specific address to prefer (e.g. a playbook identity email). */
  preferAddress?: string | null;
  /** Pre-resolved Mailgun settings, to save a lookup when the caller has them. */
  legacy?: LegacyCreds;
}

export interface SenderDecision {
  sender: ResolvedSender | null;
  /**
   * Set when the obstacle is only timing — a cap or the pacing interval. The
   * touch is still wanted, just not this minute, so callers should reschedule
   * rather than hand a human a draft to approve.
   */
  retryAt?: Date;
  /** Why there is no sender, phrased for whoever reads the outcome. */
  reason?: string;
}

/** A mailbox weighed against its allowance for right now. */
interface Candidate {
  mailbox: MailboxWithDomain;
  load: MailboxLoad;
  allowance: number;
  /** Earliest this mailbox may send again. */
  readyAt: Date;
  hasCapacity: boolean;
}

/**
 * Weigh candidates against their warm-up allowance, hourly cap and pacing
 * interval. Capacity applies to cold outreach only: transactional mail is
 * low-volume and must not be delayed by a ramp built for prospecting.
 */
async function weigh(
  mailboxes: MailboxWithDomain[],
  purpose: SenderPurpose,
  now: Date
): Promise<Candidate[]> {
  if (mailboxes.length === 0) return [];
  if (purpose === 'TRANSACTIONAL') {
    return mailboxes.map((mailbox) => ({
      mailbox,
      load: EMPTY_LOAD,
      allowance: mailbox.dailyCapMax,
      readyAt: now,
      hasCapacity: true,
    }));
  }

  const loads = await loadFor(
    mailboxes.map((m) => m.id),
    now
  );
  return mailboxes.map((mailbox) => {
    const load = loads.get(mailbox.id) ?? EMPTY_LOAD;
    const allowance = dailyAllowance(mailbox, load, now);
    const paceReadyAt = nextSendAt(mailbox, now);
    const withinDaily = load.sentToday < allowance;
    const withinHourly = load.sentLastHour < Math.max(1, mailbox.hourlyCap);
    const hasCapacity = withinDaily && withinHourly && paceReadyAt <= now;

    // Each obstacle clears at a different time, and the caller reschedules
    // against whichever is furthest out.
    let readyAt = paceReadyAt;
    if (!withinHourly && load.hourlySlotFreesAt && load.hourlySlotFreesAt > readyAt) {
      readyAt = load.hourlySlotFreesAt;
    }
    // A spent daily allowance does not free up until the day rolls over.
    if (!withinDaily) readyAt = nextDayReset(now);
    // Never hand back a retry time in the past: the cadence sweep would treat
    // the touch as due again immediately and burn an agent run every pass.
    if (!hasCapacity && readyAt <= now) readyAt = new Date(now.getTime() + 60 * 1000);

    return { mailbox, load, allowance, readyAt, hasCapacity };
  });
}

/** Spread volume: fewest sends today wins, then whoever has rested longest. */
function bestOf(candidates: Candidate[]): Candidate {
  return [...candidates].sort((a, b) => {
    const diff = a.load.sentToday - b.load.sentToday;
    if (diff !== 0) return diff;
    return (
      (a.mailbox.lastSendAt?.getTime() ?? 0) - (b.mailbox.lastSendAt?.getTime() ?? 0)
    );
  })[0];
}

function earliest(candidates: Candidate[]): Date | undefined {
  const times = candidates.map((c) => c.readyAt.getTime());
  return times.length ? new Date(Math.min(...times)) : undefined;
}

/**
 * Resolve the inbox transport for one connected account.
 *
 * Deliberately simpler than the Mailgun path, because the thing being modelled
 * is simpler: one address, no pool to spread across, no warm-up curve to serve.
 * What remains is the part that still matters at twenty emails a day — a daily
 * ceiling well under Google's own (hitting theirs locks sending for about a day)
 * and a minimum gap between sends, because a person does not send eight emails
 * in eight seconds.
 *
 * Transactional mail skips both. A booking confirmation the prospect is waiting
 * on must not queue behind a prospecting cap, exactly as it does not on Mailgun.
 */
async function gmailDecision(
  account: GmailAccount,
  purpose: SenderPurpose,
  now: Date
): Promise<SenderDecision> {
  if (account.status !== 'CONNECTED') {
    return { sender: null, reason: gmailUnavailableReason(account) };
  }

  const sender: ResolvedSender = {
    transport: 'gmail',
    mailboxId: null,
    gmailAccountId: account.id,
    fromEmail: account.emailAddress,
    displayName: account.displayName ?? undefined,
  };
  if (purpose === 'TRANSACTIONAL') return { sender };

  const sentToday = gmailSentToday(account, now);
  if (sentToday >= account.dailySendCap) {
    return {
      sender: null,
      retryAt: nextDayReset(now),
      reason:
        `${account.emailAddress} has sent its ${account.dailySendCap} for today. ` +
        'The touch is still wanted — it goes out when the day rolls over.',
    };
  }

  const readyAt = gmailNextSendAt(account, now);
  if (readyAt > now) {
    return {
      sender: null,
      retryAt: readyAt,
      reason:
        `${account.emailAddress} is pacing its sends (one every ` +
        `${account.minSpacingSeconds}s) — next opening ${readyAt.toISOString()}.`,
    };
  }

  return { sender: { ...sender, allowanceToday: account.dailySendCap } };
}

function gmailUnavailableReason(account: GmailAccount): string {
  switch (account.status) {
    case 'EXPIRED':
      return `${account.emailAddress} needs reconnecting — Google has revoked this connection${
        account.lastError ? ` (${account.lastError})` : ''
      }. Message saved as a draft.`;
    case 'PAUSED':
      return `${account.emailAddress} is paused by hand — nothing sends from it until it is resumed. Message saved as a draft.`;
    default:
      return `${account.emailAddress} is erroring${
        account.lastError ? ` (${account.lastError})` : ''
      }. Message saved as a draft.`;
  }
}

/** Look up the inbox a playbook routes through, or say why there isn't one. */
async function gmailForPlaybook(
  organizationId: string,
  gmailAccountId: string | null,
  purpose: SenderPurpose,
  now: Date
): Promise<SenderDecision> {
  const resolved = await accountForPlaybook(organizationId, gmailAccountId);
  if (!resolved.account) {
    return { sender: null, reason: `${resolved.reason} Message saved as a draft.` };
  }
  return gmailDecision(resolved.account, purpose, now);
}

/**
 * Pick the mailbox a message should leave from.
 *
 * Order: the thread's existing mailbox, then a specifically requested address,
 * then the playbook's pool, then anything the org has for that purpose.
 *
 * Returns no sender when cold outreach has no capacity. If the obstacle is a cap
 * or the pacing interval, `retryAt` says when to come back — the caller should
 * reschedule. Transactional mail always resolves while the legacy settings are
 * configured: a worn-out cold domain must not stop meeting invites.
 */
export async function resolveSenderDecision(
  organizationId: string,
  req: SenderRequest = {}
): Promise<SenderDecision> {
  const purpose: SenderPurpose = req.purpose ?? 'COLD_OUTREACH';
  const legacy = req.legacy ?? (await legacyCreds(organizationId));
  const now = new Date();

  const playbook = req.playbookId
    ? await prisma.playbook.findFirst({
        where: { id: req.playbookId, organizationId },
        select: { senderPoolId: true, emailTransport: true, gmailAccountId: true },
      })
    : null;

  const conversation = req.conversationId
    ? await prisma.conversation.findFirst({
        where: { id: req.conversationId, organizationId },
        select: {
          gmailAccount: true,
          mailbox: { include: { emailDomain: true } },
        },
      })
    : null;

  // A thread that left from an inbox stays in that inbox, whatever the playbook
  // now says. Stickiness outranks the playbook's transport on purpose: from the
  // prospect's side, a reply arriving from a different address is a stranger
  // answering their reply, and the Gmail thread it belongs to is unreachable
  // from any other account.
  if (conversation?.gmailAccount) {
    return gmailDecision(conversation.gmailAccount, purpose, now);
  }

  // Otherwise the playbook decides. A playbook routed through an inbox never
  // falls back to Mailgun: "send as this person, from their own inbox" is the
  // whole point, and quietly substituting a cold-outreach domain would put a
  // stranger's address on mail the recipient was told came from a colleague.
  if (playbook?.emailTransport === 'GMAIL') {
    return gmailForPlaybook(organizationId, playbook.gmailAccountId, purpose, now);
  }

  // Sticky: a thread keeps the address it started with. Rotating mid-thread
  // breaks References/In-Reply-To threading and reads as spoofing to the human,
  // so a thread whose mailbox is merely out of capacity waits for it rather
  // than being handed to a different sender.
  if (req.conversationId) {
    const sticky = conversation?.mailbox;
    if (sticky && isMailboxAvailable(sticky, now)) {
      const [candidate] = await weigh([sticky], purpose, now);
      if (candidate.hasCapacity) {
        const sender = await senderFromMailbox(organizationId, sticky, legacy, candidate.allowance);
        if (sender) return { sender };
      }
      return {
        sender: null,
        retryAt: candidate.readyAt,
        reason: `${sticky.address} already sent its allowance for now — this thread stays with it rather than switching sender.`,
      };
    }
    // Out on a cooldown rather than out of service: wait for it. Handing the
    // thread to another address would do the very thing stickiness exists to
    // prevent, and the mailbox is coming back within the day. A mailbox retired
    // or paused by hand has no return date, so those fall through to a new
    // sender rather than stranding the conversation.
    if (sticky?.pausedUntil && sticky.pausedUntil > now && sticky.status !== 'RETIRED') {
      return {
        sender: null,
        retryAt: sticky.pausedUntil,
        reason: `${sticky.address} is paused until ${sticky.pausedUntil.toISOString()} (${sticky.pausedReason ?? 'deliverability'}); this thread waits for it rather than switching sender.`,
      };
    }
  }

  if (req.preferAddress) {
    const preferred = await prisma.mailbox.findFirst({
      where: {
        organizationId,
        address: req.preferAddress.trim().toLowerCase(),
        emailDomain: { purpose },
        ...(playbook?.senderPoolId ? { pools: { some: { poolId: playbook.senderPoolId } } } : {}),
      },
      include: { emailDomain: true },
    });
    if (preferred && isMailboxAvailable(preferred, now)) {
      const [candidate] = await weigh([preferred], purpose, now);
      // Only a preference, not a commitment: if it is spent, try the pool.
      if (candidate.hasCapacity) {
        const sender = await senderFromMailbox(organizationId, preferred, legacy, candidate.allowance);
        if (sender) return { sender };
      }
    }
  }

  const poolId = playbook?.senderPoolId ?? null;

  const mailboxes = await prisma.mailbox.findMany({
    where: {
      organizationId,
      emailDomain: { purpose },
      ...(poolId ? { pools: { some: { poolId } } } : {}),
    },
    include: { emailDomain: true },
  });
  const usable = mailboxes.filter((m) => isMailboxAvailable(m, now));
  const candidates = await weigh(usable, purpose, now);
  const ready = candidates.filter((c) => c.hasCapacity);

  if (ready.length > 0) {
    const chosen = bestOf(ready);
    const sender = await senderFromMailbox(
      organizationId,
      chosen.mailbox,
      legacy,
      chosen.allowance
    );
    if (sender) return { sender };
    // Mailboxes are ready and within their allowance, but nothing can
    // authenticate as them. Reporting that as a spent cap would send someone
    // looking at warm-up settings for a missing API key.
    return { sender: null, reason: missingKeyReason() };
  }

  // A pool that exists but is spent must not silently spill onto other
  // mailboxes — that is the cap failing open. Only fall back when the org has
  // nothing configured for this purpose at all.
  const configuredForPurpose = poolId
    ? await prisma.mailbox.count({ where: { organizationId, emailDomain: { purpose } } })
    : mailboxes.length;

  if (purpose === 'COLD_OUTREACH' && configuredForPurpose === 0) return { sender: null, reason: 'Register and verify a sending mailbox before cold outreach. Legacy settings do not enforce mailbox warm-up.' };

  if (purpose === 'TRANSACTIONAL') {
    const fallback = legacySender(legacy, req.preferAddress);
    if (fallback) return { sender: fallback };
    // Mailgun isn't set up at all. An org running entirely out of a connected
    // inbox still owes its prospects booking confirmations and reminders, so
    // those ride the inbox rather than silently not being sent.
    const inbox = await anyUsableGmailAccount(organizationId);
    if (inbox) return gmailDecision(inbox, purpose, now);
    return { sender: null, reason: unconfiguredReason() };
  }

  // Everything is merely spent rather than paused: say when to come back.
  if (candidates.length > 0) {
    const retryAt = earliest(candidates);
    return {
      sender: null,
      retryAt,
      reason:
        `Every available mailbox has spent its allowance for now ` +
        `(${candidates.length} checked). Next opening ${retryAt?.toISOString() ?? 'unknown'}.`,
    };
  }

  return { sender: null, reason: pausedReason(mailboxes.length) };
}

/**
 * Thin wrapper for callers that only need an address and have nothing useful to
 * do with a retry time — transactional mail, mostly.
 */
export async function resolveSender(
  organizationId: string,
  req: SenderRequest = {}
): Promise<ResolvedSender | null> {
  return (await resolveSenderDecision(organizationId, req)).sender;
}

function missingKeyReason(): string {
  return (
    'A mailbox is ready to send but no Mailgun API key is available for its ' +
    'domain — set one on the domain, or an org-wide MAILGUN_API_KEY in Settings. ' +
    'Message saved as a draft.'
  );
}

function unconfiguredReason(): string {
  return (
    'No email transport is set up — add Mailgun credentials or connect a Gmail ' +
    'inbox under Settings → Sending. Message saved as a draft.'
  );
}

function pausedReason(configured: number): string {
  if (configured === 0) return unconfiguredReason();
  return (
    `No sending mailbox is available. This org has ${configured} cold-outreach ` +
    `mailbox${configured === 1 ? '' : 'es'}, but none can send — they are paused, ` +
    'sit on a domain whose DNS is unverified, or are not in the sender pool this ' +
    'playbook is assigned to. Message saved as a draft.'
  );
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type MailboxStatField =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'replied';

/** UTC midnight for a timestamp — the key daily stats are bucketed by. */
export function utcDay(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Count one delivery event against a mailbox's day. Best-effort: a stats write
 * must never be the reason a send or a webhook fails.
 */
export async function recordMailboxEvent(
  mailboxId: string,
  field: MailboxStatField,
  at: Date = new Date()
): Promise<void> {
  const date = utcDay(at);
  await prisma.mailboxDailyStat
    .upsert({
      where: { mailboxId_date: { mailboxId, date } },
      create: { mailboxId, date, [field]: 1 } as Prisma.MailboxDailyStatUncheckedCreateInput,
      update: { [field]: { increment: 1 } } as Prisma.MailboxDailyStatUncheckedUpdateInput,
    })
    .catch(() => undefined);
}

/**
 * Claim one send against a mailbox's allowance for today.
 *
 * The check in `weigh` is a read, and two agents resolving a sender at the same
 * instant both see the same remaining allowance — so the check alone lets a cap
 * be exceeded by however many sends are in flight. The claim here is a single
 * conditional UPDATE, which Postgres serialises: the `sent < allowance` guard
 * and the increment cannot be split, so exactly one caller gets the last slot.
 *
 * Returns false when the allowance is already spent; the caller must not send.
 */
export async function reserveSend(
  mailboxId: string,
  allowance: number,
  at: Date = new Date()
): Promise<boolean> {
  const date = utcDay(at);
  // The guarded update needs a row to match; creating it at zero is a no-op
  // when one already exists.
  await prisma.mailboxDailyStat
    .upsert({ where: { mailboxId_date: { mailboxId, date } }, create: { mailboxId, date }, update: {} })
    .catch(() => undefined);

  const claimed = await prisma.mailboxDailyStat.updateMany({
    where: { mailboxId, date, sent: { lt: allowance } },
    data: { sent: { increment: 1 } },
  });
  return claimed.count === 1;
}

/**
 * Give back a slot claimed by `reserveSend` when the send did not happen — a
 * provider rejection, say. Without this a failed attempt would permanently cost
 * the mailbox a send it never made.
 */
export async function releaseSend(mailboxId: string, at: Date = new Date()): Promise<void> {
  const date = utcDay(at);
  await prisma.mailboxDailyStat
    .updateMany({ where: { mailboxId, date, sent: { gt: 0 } }, data: { sent: { decrement: 1 } } })
    .catch(() => undefined);
}

/**
 * Record that a mailbox just sent. Also starts the warm-up clock and the
 * domain's reputation history on first use, so the ramp is dated from the first
 * real send rather than from whenever the row happened to be created.
 */
export async function markMailboxSent(
  mailboxId: string,
  at: Date = new Date(),
  /** False when `reserveSend` already counted this send against the ledger. */
  countSend = true
): Promise<void> {
  if (countSend) await recordMailboxEvent(mailboxId, 'sent', at);
  // Conditional updates rather than read-then-write: two sends racing on a fresh
  // mailbox would otherwise both see a null clock and the later one would win.
  await prisma.mailbox
    .updateMany({ where: { id: mailboxId, warmupStartedAt: null }, data: { warmupStartedAt: at } })
    .catch(() => undefined);
  const mailbox = await prisma.mailbox
    .update({ where: { id: mailboxId }, data: { lastSendAt: at } })
    .catch(() => null);
  if (!mailbox) return;

  // A ramp that has reached its ceiling has nothing left to do — promote the
  // mailbox so it stops being evaluated against a curve it has finished. Judged
  // on the real load: a mailbox whose ramp is halted for bouncing has not
  // finished anything, and promoting it would put it beyond the halt brake.
  const load = (await loadFor([mailboxId], at)).get(mailboxId) ?? EMPTY_LOAD;
  if (mailbox.status === 'WARMING' && dailyAllowance(mailbox, load, at) >= mailbox.dailyCapMax) {
    // Guarded on WARMING: the health sweep may have paused this mailbox between
    // the read above and this write, and an unconditional update would quietly
    // put a just-paused sender back into service.
    await prisma.mailbox
      .updateMany({ where: { id: mailboxId, status: 'WARMING' }, data: { status: 'ACTIVE' } })
      .catch(() => undefined);
  }

  await prisma.emailDomain
    .updateMany({ where: { id: mailbox.domainId, firstSendAt: null }, data: { firstSendAt: at } })
    .catch(() => undefined);
}

/** Attribute an event to whichever mailbox sent the message it refers to. */
export async function recordEventForMessage(
  messageId: string,
  field: MailboxStatField,
  at: Date = new Date()
): Promise<void> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { mailboxId: true },
  });
  if (message?.mailboxId) await recordMailboxEvent(message.mailboxId, field, at);
}

// ---------------------------------------------------------------------------
// Provider verification
// ---------------------------------------------------------------------------

const and = (current: boolean | null, next: boolean): boolean =>
  current === null ? next : current && next;

/**
 * Re-read a domain's DNS state from Mailgun and store it.
 *
 * SPF and DKIM decide whether mail is trusted; MX decides whether replies ever
 * reach us; the tracking CNAME decides whether open/click links carry this
 * domain or a shared provider one, which is itself a deliverability signal. A
 * PENDING domain that comes back authenticated is promoted to WARMING — that is
 * the only automatic status change here.
 */
export async function verifyDomainDns(domainId: string): Promise<EmailDomain> {
  const domain = await prisma.emailDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new Error('Domain not found');

  const apiKey = await apiKeyForDomain(domain.organizationId, domain);
  if (!apiKey) throw new Error('No Mailgun API key available for this domain');

  const result = await mailgunGet(`/domains/${encodeURIComponent(domain.domain)}`, apiKey);
  const sending: any[] = result?.sending_dns_records || [];
  const receiving: any[] = result?.receiving_dns_records || [];

  let spfOk: boolean | null = null;
  let dkimOk: boolean | null = null;
  let trackingOk: boolean | null = null;

  for (const record of sending) {
    const valid = String(record?.valid).toLowerCase() === 'valid';
    const type = String(record?.record_type || '').toUpperCase();
    const name = String(record?.name || '').toLowerCase();
    const value = String(record?.value || '').toLowerCase();
    if (type === 'TXT' && value.includes('v=spf1')) spfOk = and(spfOk, valid);
    else if (type === 'TXT' && name.includes('_domainkey')) dkimOk = and(dkimOk, valid);
    else if (type === 'CNAME') trackingOk = and(trackingOk, valid);
  }

  const mxOk =
    receiving.length === 0
      ? false
      : receiving.every((record) => String(record?.valid).toLowerCase() === 'valid');

  const authenticated = spfOk === true && dkimOk === true;
  return prisma.emailDomain.update({
    where: { id: domainId },
    data: {
      spfOk,
      dkimOk,
      trackingOk,
      mxOk,
      lastCheckedAt: new Date(),
      ...(domain.status === 'PENDING' && authenticated ? { status: 'WARMING' as const } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Adoption & reporting
// ---------------------------------------------------------------------------

/**
 * Bring an organization's existing single-domain setup into these tables so it
 * keeps sending from the same address while new domains are added alongside it.
 * Idempotent, and a no-op when Mailgun was never configured.
 */
export async function adoptLegacyDomain(organizationId: string): Promise<EmailDomain | null> {
  const legacy = await legacyCreds(organizationId);
  if (!legacy.apiKey || !legacy.domain) return null;

  const domainName = legacy.domain.trim().toLowerCase();
  const existing = await prisma.emailDomain.findUnique({ where: { domain: domainName } });
  if (existing) return existing.organizationId === organizationId ? existing : null;

  // Adopting settings proves neither DNS nor reputation. Verify and warm conservatively.
  const domain = await prisma.emailDomain.create({
    data: {
      organizationId,
      domain: domainName,
      purpose: 'COLD_OUTREACH',
      status: 'WARMING',
    },
  });

  const configured = senderAddress(legacy).toLowerCase();
  const address = configured.endsWith(`@${domainName}`) ? configured : `noreply@${domainName}`;

  // This address has been carrying the org's entire output, so its ceiling is
  // whatever the org already allows itself per day — not the cautious default a
  // brand-new mailbox gets. dailyCapStart is deliberately left alone: if the
  // breaker ever pauses this mailbox it should come back on a gentle ramp.
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { dailySendCap: true },
  });
  const ceiling = Math.max(40, org?.dailySendCap ?? 200);

  await prisma.mailbox.create({
    data: {
      organizationId,
      domainId: domain.id,
      localPart: address.split('@')[0],
      address,
      status: 'WARMING',
      warmupStartedAt: null,
      dailyCapMax: ceiling,
      hourlyCap: Math.max(8, Math.ceil(ceiling / 8)),
    },
  });
  return domain;
}

/** Domains, their mailboxes, and today's volume — for the API and the Engine. */
export async function getSendingOverview(organizationId: string) {
  const domains = await prisma.emailDomain.findMany({
    where: { organizationId },
    include: { mailboxes: { orderBy: { address: 'asc' } } },
    orderBy: [{ purpose: 'asc' }, { domain: 'asc' }],
  });
  const mailboxIds = domains.flatMap((d) => d.mailboxes.map((m) => m.id));
  const now = new Date();
  const stats = mailboxIds.length
    ? await prisma.mailboxDailyStat.findMany({
        where: { mailboxId: { in: mailboxIds }, date: utcDay(now) },
      })
    : [];
  const statsById = new Map(stats.map((s) => [s.mailboxId, s]));
  const loads = await loadFor(mailboxIds, now);

  const legacy = await legacyCreds(organizationId);
  return {
    // True while the org still relies on the single MAILGUN_DOMAIN setting.
    usingLegacySettings: domains.length === 0 && !!legacy.domain,
    legacyDomain: legacy.domain || null,
    domains: domains.map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      purpose: domain.purpose,
      status: domain.status,
      dns: {
        spf: domain.spfOk,
        dkim: domain.dkimOk,
        mx: domain.mxOk,
        tracking: domain.trackingOk,
        lastCheckedAt: domain.lastCheckedAt,
      },
      pausedReason: domain.pausedReason,
      firstSendAt: domain.firstSendAt,
      mailboxes: domain.mailboxes.map((mailbox) => {
        const today = statsById.get(mailbox.id);
        const load = loads.get(mailbox.id) ?? EMPTY_LOAD;
        const allowance = dailyAllowance(mailbox, load, now);
        return {
          id: mailbox.id,
          address: mailbox.address,
          displayName: mailbox.displayName,
          status: mailbox.status,
          warmupStartedAt: mailbox.warmupStartedAt,
          dailyCapMax: mailbox.dailyCapMax,
          // What the ramp allows today, and what is left of it.
          allowanceToday: allowance,
          remainingToday: Math.max(0, allowance - load.sentToday),
          sentLastHour: load.sentLastHour,
          hourlyCap: mailbox.hourlyCap,
          rampHalted: load.rampHalted,
          nextSendAt: nextSendAt(mailbox, now),
          pausedReason: mailbox.pausedReason,
          pausedUntil: mailbox.pausedUntil,
          lastSendAt: mailbox.lastSendAt,
          today: {
            sent: today?.sent ?? 0,
            delivered: today?.delivered ?? 0,
            bounced: today?.bounced ?? 0,
            complained: today?.complained ?? 0,
            replied: today?.replied ?? 0,
          },
        };
      }),
    })),
  };
}

/**
 * Whether this organization can send email at all, by any route.
 *
 * The Engine's system prompt is told which channels exist, and it takes that
 * literally — told email is unconfigured, it stops offering to send any. Read
 * off the Mailgun settings alone, an organization running entirely out of a
 * connected inbox would be told it has no email channel while sending mail all
 * day.
 */
export async function hasAnyEmailTransport(
  organizationId: string,
  legacy?: { apiKey: string; domain: string }
): Promise<boolean> {
  const creds = legacy ?? (await legacyCreds(organizationId));
  if (creds.apiKey && creds.domain) return true;

  const [inboxes, mailboxes] = await Promise.all([
    prisma.gmailAccount.count({ where: { organizationId, status: 'CONNECTED' } }),
    prisma.mailbox.count({
      where: {
        organizationId,
        status: { in: ['WARMING', 'ACTIVE'] },
        emailDomain: { status: { in: ['WARMING', 'ACTIVE'] }, apiKeyEncrypted: { not: null } },
      },
    }),
  ]);
  return inboxes > 0 || mailboxes > 0;
}

/**
 * An address replies to this org are known to reach.
 *
 * Used where something must be given out for a human to answer — a contact-form
 * enquiry, an invite's ORGANIZER line. A connected inbox qualifies: its replies
 * are polled onto the lead exactly as a Mailgun reply is, so an answer sent
 * there is not lost.
 */
export async function replyAddressFor(
  organizationId: string,
  legacy?: { apiKey: string; domain: string; fromEmail: string }
): Promise<string | null> {
  const creds = legacy ?? (await legacyCreds(organizationId));
  if (creds.domain) return senderAddress(creds);
  const inbox = await anyUsableGmailAccount(organizationId);
  return inbox?.emailAddress ?? null;
}

/** Every address this org sends from — used to validate playbook identities. */
export async function knownAddresses(organizationId: string): Promise<Set<string>> {
  const mailboxes = await prisma.mailbox.findMany({
    where: { organizationId },
    select: { address: true },
  });
  return new Set(mailboxes.map((m) => m.address.toLowerCase()));
}
