import { prisma } from '../config/database';
import { dailyAllowance, loadFor } from './sender.service';
import { listRuns } from '../engine/run-registry';

/**
 * What the platform has ACTUALLY been doing — as opposed to what it is
 * configured to do, or what it will do next.
 *
 * The Engine had neither. It could read one lead's timeline, report which
 * integrations were configured, list what was SCHEDULED, and quote remaining
 * send capacity — but nothing anywhere gave it an organization-wide view of
 * sends that had already happened. Asked "is any outreach going out?", it had
 * no tool that answers the question, so it inferred from the two signals it
 * did have and got it backwards: during warm-up, a mailbox that has spent its
 * allowance reports zero remaining capacity and an empty due-queue, which reads
 * as "nothing is happening" at exactly the moment the most has just happened.
 *
 * So this reports observed facts, over several windows, with the warm-up
 * mechanics spelled out — because the honest answer to "why is capacity zero
 * but mail is flowing" is "both are true, and that is what pacing looks like".
 */

export interface PulseWindow {
  label: string;
  hours: number;
  emailsSent: number;
  smsSent: number;
  callsPlaced: number;
  socialTouches: number;
  totalTouches: number;
  repliesReceived: number;
}

export interface OutreachPulse {
  now: string;
  windows: PulseWindow[];
  /** The single most useful fact: when did something last actually go out. */
  lastOutboundAt: string | null;
  lastOutboundSummary: string | null;
  inFlight: {
    runningAgents: number;
    queuedMessages: number;
    messagesBeingSent: number;
    jobsDueNow: number;
    draftsAwaitingApproval: number;
  };
  mailboxes: {
    address: string;
    status: string;
    sentToday: number;
    allowanceToday: number;
    remainingToday: number;
    lastSendAt: string | null;
  }[];
  campaigns: {
    name: string;
    status: string;
    touchesInWindow: number;
    leadsInSequence: number;
    leadsHeld: number;
    nextTouchDueAt: string | null;
  }[];
  orgPaused: boolean;
  /** Plain-language reading of the numbers above, so the agent cannot invert it. */
  verdict: string;
}

const OUTBOUND_TYPES = ['EMAIL_SENT', 'SMS_SENT', 'CALL_PLACED', 'SOCIAL_TOUCH'] as const;
const REPLY_TYPES = ['EMAIL_REPLY', 'SMS_REPLY'] as const;

const WINDOWS: { label: string; hours: number }[] = [
  { label: 'last hour', hours: 1 },
  { label: 'last 24 hours', hours: 24 },
  { label: 'last 7 days', hours: 24 * 7 },
];

async function windowCounts(
  organizationId: string,
  now: Date,
  spec: { label: string; hours: number }
): Promise<PulseWindow> {
  const since = new Date(now.getTime() - spec.hours * 3600 * 1000);
  const [byType, replies] = await Promise.all([
    prisma.activity.groupBy({
      by: ['type'],
      where: { organizationId, createdAt: { gte: since }, type: { in: [...OUTBOUND_TYPES] } },
      _count: { _all: true },
    }),
    prisma.activity.count({
      where: { organizationId, createdAt: { gte: since }, type: { in: [...REPLY_TYPES] } },
    }),
  ]);
  const count = (t: string) => byType.find((r) => r.type === t)?._count._all ?? 0;
  const emailsSent = count('EMAIL_SENT');
  const smsSent = count('SMS_SENT');
  const callsPlaced = count('CALL_PLACED');
  const socialTouches = count('SOCIAL_TOUCH');

  return {
    label: spec.label,
    hours: spec.hours,
    emailsSent,
    smsSent,
    callsPlaced,
    socialTouches,
    totalTouches: emailsSent + smsSent + callsPlaced + socialTouches,
    repliesReceived: replies,
  };
}

export async function getOutreachPulse(
  organizationId: string,
  now: Date = new Date()
): Promise<OutreachPulse> {
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

  const [windows, lastOutbound, org, runningAgents, queuedMessages, sendingMessages, drafts, jobsDueNow, mailboxRows, campaignRows] =
    await Promise.all([
      Promise.all(WINDOWS.map((w) => windowCounts(organizationId, now, w))),
      prisma.activity.findFirst({
        where: { organizationId, type: { in: [...OUTBOUND_TYPES] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, summary: true },
      }),
      prisma.organization.findUnique({ where: { id: organizationId }, select: { paused: true } }),
      prisma.agentRun.count({ where: { organizationId, status: 'RUNNING' } }),
      prisma.message.count({
        where: { status: 'scheduled', conversation: { organizationId } },
      }),
      prisma.message.count({ where: { status: 'sending', conversation: { organizationId } } }),
      prisma.message.count({
        where: { status: 'draft_pending_approval', conversation: { organizationId } },
      }),
      prisma.agentJob.count({ where: { organizationId, status: 'PENDING', runAt: { lte: now } } }),
      prisma.mailbox.findMany({
        where: { organizationId, status: { not: 'RETIRED' } },
        select: {
          id: true,
          address: true,
          status: true,
          lastSendAt: true,
          warmupStartedAt: true,
          dailyCapStart: true,
          dailyCapMax: true,
          warmupGrowthPct: true,
          hourlyCap: true,
          createdAt: true,
        },
        take: 100,
      }),
      prisma.campaign.findMany({
        where: { organizationId, status: { in: ['ACTIVE', 'PAUSED'] } },
        select: { id: true, name: true, status: true },
        take: 50,
      }),
    ]);

  // Per-mailbox: what it has spent today against what warm-up allows. This is
  // the pair of numbers that makes "capacity is zero AND mail went out" legible.
  const loads = await loadFor(
    mailboxRows.map((m) => m.id),
    now
  );
  const mailboxes = mailboxRows.map((m) => {
    const load = loads.get(m.id) ?? { sentToday: 0, sentLastHour: 0, rampHalted: false };
    const allowance = dailyAllowance(m as never, load as never, now);
    return {
      address: m.address,
      status: m.status,
      sentToday: load.sentToday,
      allowanceToday: allowance,
      remainingToday: Math.max(0, allowance - load.sentToday),
      lastSendAt: m.lastSendAt?.toISOString() ?? null,
    };
  });

  const campaigns = await Promise.all(
    campaignRows.map(async (c) => {
      const [touches, inSequence, held, next] = await Promise.all([
        prisma.activity.count({
          where: {
            organizationId,
            campaignId: c.id,
            type: { in: [...OUTBOUND_TYPES] },
            createdAt: { gte: dayAgo },
          },
        }),
        prisma.campaignLead.count({
          where: { campaignId: c.id, status: { in: ['PENDING', 'IN_SEQUENCE'] }, pausedAt: null },
        }),
        prisma.campaignLead.count({ where: { campaignId: c.id, pausedAt: { not: null } } }),
        prisma.campaignLead.findFirst({
          where: {
            campaignId: c.id,
            status: { in: ['PENDING', 'IN_SEQUENCE'] },
            pausedAt: null,
            nextTouchAt: { not: null },
          },
          orderBy: { nextTouchAt: 'asc' },
          select: { nextTouchAt: true },
        }),
      ]);
      return {
        name: c.name,
        status: c.status,
        touchesInWindow: touches,
        leadsInSequence: inSequence,
        leadsHeld: held,
        nextTouchDueAt: next?.nextTouchAt?.toISOString() ?? null,
      };
    })
  );

  const hour = windows[0];
  const day = windows[1];
  const live = listRuns(organizationId).length;

  return {
    now: now.toISOString(),
    windows,
    lastOutboundAt: lastOutbound?.createdAt.toISOString() ?? null,
    lastOutboundSummary: lastOutbound?.summary ?? null,
    inFlight: {
      // The DB count is the durable one; the in-memory registry only knows runs
      // this process started, which is a subset after a restart.
      runningAgents: Math.max(runningAgents, live),
      queuedMessages,
      messagesBeingSent: sendingMessages,
      jobsDueNow,
      draftsAwaitingApproval: drafts,
    },
    mailboxes,
    campaigns,
    orgPaused: !!org?.paused,
    verdict: buildVerdict({ hour, day, mailboxes, queuedMessages, orgPaused: !!org?.paused, lastOutbound }),
  };
}

/**
 * State the conclusion outright.
 *
 * Left to infer from raw counts, an agent reads "0 remaining capacity" as "no
 * outreach" and tells the operator nothing is happening while their prospects
 * are receiving mail. Naming the case removes the inference step.
 */
function buildVerdict(input: {
  hour: PulseWindow;
  day: PulseWindow;
  mailboxes: { sentToday: number; remainingToday: number }[];
  queuedMessages: number;
  orgPaused: boolean;
  lastOutbound: { createdAt: Date } | null;
}): string {
  const { hour, day, mailboxes, queuedMessages, orgPaused, lastOutbound } = input;

  if (orgPaused) {
    return 'Outreach is STOPPED: the organization kill switch is on. Nothing will send until it is turned off in Settings.';
  }

  const sentToday = mailboxes.reduce((n, m) => n + m.sentToday, 0);
  const capacityLeft = mailboxes.reduce((n, m) => n + m.remainingToday, 0);
  const ago = lastOutbound
    ? `${Math.round((Date.now() - lastOutbound.createdAt.getTime()) / 60000)} minute(s) ago`
    : 'never';

  if (day.totalTouches === 0 && queuedMessages === 0) {
    return `Outreach is IDLE: nothing has gone out in the last 24 hours and nothing is queued. Last outbound touch: ${ago}.`;
  }

  const parts: string[] = [
    `Outreach IS RUNNING. ${day.totalTouches} touch(es) went out in the last 24 hours ` +
      `(${hour.totalTouches} in the last hour), ${day.repliesReceived} repl(ies) came back. ` +
      `Last outbound: ${ago}.`,
  ];

  // The specific confusion this tool exists to prevent.
  if (mailboxes.length > 0 && capacityLeft === 0 && sentToday > 0) {
    parts.push(
      `Every mailbox has spent its warm-up allowance for today (${sentToday} sent). That is a pacing ` +
        'ceiling, NOT a stoppage — the allowance rises daily and resets tomorrow. Do not report this as ' +
        '"no outreach is happening": mail has already gone out today, and more will go out tomorrow.'
    );
  } else if (mailboxes.length > 0 && capacityLeft > 0) {
    parts.push(`About ${capacityLeft} more cold email(s) can still go out today.`);
  }

  if (queuedMessages > 0) {
    parts.push(
      `${queuedMessages} message(s) are written and waiting on a mailbox — they send themselves when ` +
        'capacity frees up, with no further agent run.'
    );
  }

  return parts.join(' ');
}
