import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { leadService } from '../services/lead.service';

/**
 * One view over everything that will act on its own.
 *
 * Five independent mechanisms can put a message in front of a prospect without
 * anyone pressing send, and until now each was visible (if at all) in a
 * different place:
 *
 *  1. MESSAGE  — an email already written, held by sender pacing, drained by
 *                the outbound queue sweep.
 *  2. JOB      — an AgentJob the worker will wake and run (a follow-up an agent
 *                scheduled, a cadence batch, a no-show chase).
 *  3. CADENCE  — a campaign lead whose next touch is due. This one GENERATES:
 *                the sweep writes brand-new jobs and messages for it every
 *                pass, which is why cancelling messages alone never stops a
 *                campaign — the next sweep simply composes more.
 *  4. GOAL     — an Autopilot goal that re-queues its objective on a cadence,
 *                indefinitely, until someone stops it.
 *  5. REMINDER — a meeting reminder emailed to the lead 24h and 1h out.
 *
 * Stopping layer 1 or 2 while layer 3 or 4 is still running is the exact shape
 * of "I cancelled it and it still went out". So this module reports all five in
 * one feed, tells the operator which of them are generators, and gives every
 * one a hold that is reversible rather than destructive.
 */

export type ScheduledKind = 'MESSAGE' | 'JOB' | 'CADENCE' | 'GOAL' | 'REMINDER';

export type ScheduledState =
  /** Its time has come; the next sweep picks it up. */
  | 'DUE'
  /** Waiting for a future time. */
  | 'SCHEDULED'
  /** Held by an operator. Keeps everything it needs to resume. */
  | 'PAUSED'
  /** Claimed and in flight — past the point of recall. */
  | 'RUNNING'
  /** Will not move without a human. Not counted as automatic. */
  | 'NEEDS_APPROVAL';

export type ScheduledAction = 'pause' | 'resume' | 'cancel';

export interface ScheduledItem {
  /** Composite `kind:uuid`, so one selection can span every source. */
  ref: string;
  kind: ScheduledKind;
  state: ScheduledState;
  /** When this fires. Null means "as soon as the next sweep sees it". */
  dueAt: string | null;
  channel: string | null;
  /** What will happen, in one line. */
  title: string;
  /** The actual content or objective, so a decision needs no second click. */
  detail: string | null;
  lead: { id: string; companyName: string } | null;
  campaign: { id: string; name: string } | null;
  /**
   * Why this will not send even though it is scheduled — an opt-out, a hold, a
   * paused campaign. The sweeps already enforce these; surfacing them here is
   * what stops the list reading as a threat it isn't.
   */
  blockedReason: string | null;
  /** Queued mail is dropped rather than sent once it is this old. */
  expiresAt: string | null;
  meta: Record<string, unknown>;
  actions: { pause: boolean; resume: boolean; cancel: boolean };
}

export interface ScheduledFilter {
  organizationId: string;
  kinds?: ScheduledKind[];
  states?: ScheduledState[];
  campaignId?: string;
  leadId?: string;
  search?: string;
  /** Only things firing within this many hours. */
  withinHours?: number;
}

/** Rows read per kind in one list call. The counts in the summary are exact. */
const PER_KIND_LIMIT = 400;

/** Mirrors MAX_QUEUE_AGE_MS in the outbound queue — a held message still ages. */
const QUEUE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;

/** The reminder offsets reminder.service fires at, so we can show what's left. */
const REMINDER_RULES = [
  { key: '24h', leadMs: 24 * 3600 * 1000, label: '24h before' },
  { key: '1h', leadMs: 3600 * 1000, label: '1h before' },
];

const ALL_KINDS: ScheduledKind[] = ['MESSAGE', 'JOB', 'CADENCE', 'GOAL', 'REMINDER'];

export function parseRef(ref: string): { kind: ScheduledKind; id: string } | null {
  const at = ref.indexOf(':');
  if (at < 1) return null;
  const kind = ref.slice(0, at) as ScheduledKind;
  const id = ref.slice(at + 1);
  if (!ALL_KINDS.includes(kind) || !id) return null;
  return { kind, id };
}

function wants(filter: ScheduledFilter, kind: ScheduledKind): boolean {
  return !filter.kinds?.length || filter.kinds.includes(kind);
}

function wantsState(filter: ScheduledFilter, state: ScheduledState): boolean {
  return !filter.states?.length || filter.states.includes(state);
}

function horizon(filter: ScheduledFilter, now: Date): Date | null {
  return filter.withinHours ? new Date(now.getTime() + filter.withinHours * 3600 * 1000) : null;
}

function clip(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Where-builders. Shared by the list, the counts, and the "apply to everything
// matching" bulk path, so a filter can never mean one set of rows on screen and
// a different set when the operator acts on it.
// ---------------------------------------------------------------------------

function messageWhere(filter: ScheduledFilter, now: Date): Prisma.MessageWhereInput {
  const until = horizon(filter, now);
  const byState: Prisma.MessageWhereInput[] = [];
  if (wantsState(filter, 'DUE')) byState.push({ status: 'scheduled', scheduledAt: { lte: now } });
  if (wantsState(filter, 'SCHEDULED')) byState.push({ status: 'scheduled', scheduledAt: { gt: now } });
  if (wantsState(filter, 'PAUSED')) byState.push({ status: 'paused' });
  if (wantsState(filter, 'RUNNING')) byState.push({ status: 'sending' });
  if (wantsState(filter, 'NEEDS_APPROVAL')) byState.push({ status: 'draft_pending_approval' });

  const and: Prisma.MessageWhereInput[] = [];
  if (byState.length) and.push({ OR: byState });
  else return { id: '__none__' };
  // A held or unapproved row has no due time, so the horizon must let it through
  // rather than filtering out exactly the rows the operator is looking for.
  if (until) and.push({ OR: [{ scheduledAt: null }, { scheduledAt: { lte: until } }] });
  if (filter.search) {
    and.push({
      OR: [
        { subject: { contains: filter.search, mode: 'insensitive' } },
        { body: { contains: filter.search, mode: 'insensitive' } },
        { conversation: { lead: { companyName: { contains: filter.search, mode: 'insensitive' } } } },
      ],
    });
  }

  return {
    direction: 'OUTBOUND',
    conversation: {
      organizationId: filter.organizationId,
      ...(filter.leadId ? { leadId: filter.leadId } : {}),
    },
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    AND: and,
  };
}

function jobWhere(filter: ScheduledFilter, now: Date): Prisma.AgentJobWhereInput {
  const until = horizon(filter, now);
  const byState: Prisma.AgentJobWhereInput[] = [];
  if (wantsState(filter, 'DUE')) byState.push({ status: 'PENDING', runAt: { lte: now } });
  if (wantsState(filter, 'SCHEDULED')) byState.push({ status: 'PENDING', runAt: { gt: now } });
  if (wantsState(filter, 'PAUSED')) byState.push({ status: 'PAUSED' });
  if (wantsState(filter, 'RUNNING')) byState.push({ status: 'RUNNING' });

  const and: Prisma.AgentJobWhereInput[] = [];
  if (byState.length) and.push({ OR: byState });
  else return { id: '__none__' };
  if (until) and.push({ runAt: { lte: until } });
  if (filter.search) {
    and.push({
      OR: [
        { objective: { contains: filter.search, mode: 'insensitive' } },
        { lead: { companyName: { contains: filter.search, mode: 'insensitive' } } },
        { campaign: { name: { contains: filter.search, mode: 'insensitive' } } },
      ],
    });
  }

  return {
    organizationId: filter.organizationId,
    ...(filter.leadId ? { leadId: filter.leadId } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    AND: and,
  };
}

/**
 * Campaign leads whose next touch the cadence sweep would pick up.
 *
 * `touchCount < campaign.maxTouches` is a column-to-column comparison Prisma
 * cannot express, so the caller passes the campaigns it already read and the
 * limit is folded in per campaign.
 */
function cadenceWhere(
  filter: ScheduledFilter,
  now: Date,
  campaigns: { id: string; maxTouches: number }[]
): Prisma.CampaignLeadWhereInput {
  const until = horizon(filter, now);
  const byState: Prisma.CampaignLeadWhereInput[] = [];
  if (wantsState(filter, 'DUE')) {
    byState.push({ pausedAt: null, OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: now } }] });
  }
  if (wantsState(filter, 'SCHEDULED')) byState.push({ pausedAt: null, nextTouchAt: { gt: now } });
  if (wantsState(filter, 'PAUSED')) byState.push({ pausedAt: { not: null } });

  const and: Prisma.CampaignLeadWhereInput[] = [];
  if (byState.length) and.push({ OR: byState });
  else return { id: '__none__' };
  if (campaigns.length) {
    and.push({ OR: campaigns.map((c) => ({ campaignId: c.id, touchCount: { lt: c.maxTouches } })) });
  } else {
    return { id: '__none__' };
  }
  // A held row has no due time and must survive the horizon filter.
  if (until) and.push({ OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: until } }, { pausedAt: { not: null } }] });
  if (filter.search) {
    and.push({
      OR: [
        { lead: { companyName: { contains: filter.search, mode: 'insensitive' } } },
        { campaign: { name: { contains: filter.search, mode: 'insensitive' } } },
      ],
    });
  }

  return {
    status: { in: ['PENDING', 'IN_SEQUENCE'] },
    campaign: { organizationId: filter.organizationId },
    ...(filter.leadId ? { leadId: filter.leadId } : {}),
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    AND: and,
  };
}

function goalWhere(filter: ScheduledFilter, now: Date): Prisma.AutopilotGoalWhereInput {
  const until = horizon(filter, now);
  const byState: Prisma.AutopilotGoalWhereInput[] = [];
  if (wantsState(filter, 'DUE')) byState.push({ status: 'ACTIVE', nextRunAt: { lte: now } });
  if (wantsState(filter, 'SCHEDULED')) byState.push({ status: 'ACTIVE', nextRunAt: { gt: now } });
  if (wantsState(filter, 'PAUSED')) byState.push({ status: 'PAUSED' });

  const and: Prisma.AutopilotGoalWhereInput[] = [];
  if (byState.length) and.push({ OR: byState });
  else return { id: '__none__' };
  if (until) and.push({ nextRunAt: { lte: until } });
  if (filter.search) {
    and.push({
      OR: [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { objective: { contains: filter.search, mode: 'insensitive' } },
      ],
    });
  }
  // Goals are org-wide standing objectives; a lead filter has nothing to match.
  if (filter.leadId) return { id: '__none__' };

  return {
    organizationId: filter.organizationId,
    ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    AND: and,
  };
}

function reminderWhere(filter: ScheduledFilter, now: Date): Prisma.CalendarEventWhereInput {
  const until = horizon(filter, now);
  // A reminder fires relative to the meeting, so the horizon is widened by the
  // longest lead time — a meeting 30h out has a 24h reminder due in 6.
  const startBefore = until ? new Date(until.getTime() + REMINDER_RULES[0].leadMs) : null;

  // Only ever future meetings, and only the states that can still fire.
  if (!wantsState(filter, 'DUE') && !wantsState(filter, 'SCHEDULED')) return { id: '__none__' };

  return {
    organizationId: filter.organizationId,
    status: 'SCHEDULED',
    startAt: { gt: now, ...(startBefore ? { lte: startBefore } : {}) },
    leadId: filter.leadId ? filter.leadId : { not: null },
    ...(filter.campaignId ? { id: '__none__' } : {}),
    ...(filter.search
      ? {
          OR: [
            { title: { contains: filter.search, mode: 'insensitive' } },
            { lead: { companyName: { contains: filter.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
}

/** Campaigns whose cadence rows are worth listing, with the org's pause state. */
async function cadenceCampaigns(organizationId: string, campaignId?: string) {
  return prisma.campaign.findMany({
    where: {
      organizationId,
      status: { in: ['ACTIVE', 'PAUSED'] },
      ...(campaignId ? { id: campaignId } : {}),
    },
    select: {
      id: true,
      name: true,
      status: true,
      mode: true,
      maxTouches: true,
      followUpCadenceDays: true,
      channels: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ScheduledPage {
  items: ScheduledItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Kinds whose read hit PER_KIND_LIMIT, so the list is not the whole story. */
  truncatedKinds: ScheduledKind[];
}

export async function listScheduled(
  filter: ScheduledFilter,
  page = 1,
  pageSize = 50
): Promise<ScheduledPage> {
  const now = new Date();
  const campaigns = wants(filter, 'CADENCE')
    ? await cadenceCampaigns(filter.organizationId, filter.campaignId)
    : [];
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const [messages, jobs, cadence, goals, reminders] = await Promise.all([
    wants(filter, 'MESSAGE')
      ? prisma.message.findMany({
          where: messageWhere(filter, now),
          orderBy: { scheduledAt: 'asc' },
          take: PER_KIND_LIMIT,
          include: {
            conversation: {
              select: {
                id: true,
                channel: true,
                subject: true,
                lead: { select: { id: true, companyName: true, doNotContact: true, contactReviewReason: true } },
                contact: { select: { email: true, optedOut: true, emailStatus: true } },
              },
            },
            campaign: { select: { id: true, name: true, status: true, mode: true } },
          },
        })
      : [],
    wants(filter, 'JOB')
      ? prisma.agentJob.findMany({
          where: jobWhere(filter, now),
          orderBy: { runAt: 'asc' },
          take: PER_KIND_LIMIT,
          include: {
            lead: { select: { id: true, companyName: true, doNotContact: true } },
            campaign: { select: { id: true, name: true } },
          },
        })
      : [],
    wants(filter, 'CADENCE') && campaigns.length
      ? prisma.campaignLead.findMany({
          where: cadenceWhere(filter, now, campaigns),
          orderBy: [{ nextTouchAt: 'asc' }, { createdAt: 'asc' }],
          take: PER_KIND_LIMIT,
          include: {
            lead: { select: { id: true, companyName: true, doNotContact: true, contactReviewReason: true } },
          },
        })
      : [],
    wants(filter, 'GOAL')
      ? prisma.autopilotGoal.findMany({
          where: goalWhere(filter, now),
          orderBy: { nextRunAt: 'asc' },
          take: PER_KIND_LIMIT,
          include: { campaign: { select: { id: true, name: true } } },
        })
      : [],
    wants(filter, 'REMINDER')
      ? prisma.calendarEvent.findMany({
          where: reminderWhere(filter, now),
          orderBy: { startAt: 'asc' },
          take: PER_KIND_LIMIT,
          include: {
            lead: { select: { id: true, companyName: true, doNotContact: true } },
            contact: { select: { email: true, optedOut: true, emailStatus: true } },
          },
        })
      : [],
  ]);

  const items: ScheduledItem[] = [
    ...messages.map((m) => messageItem(m, now)),
    ...jobs.map(jobItem),
    ...cadence.map((cl) => cadenceItem(cl, campaignById.get(cl.campaignId)!, now)),
    ...goals.map(goalItem),
    ...reminders.flatMap((e) => reminderItem(e, now)),
  ].filter((item) => wantsState(filter, item.state));

  // Null due times sort last: they are "whenever the sweep next runs", which is
  // not a promise about ordering.
  items.sort((a, b) => {
    if (a.dueAt === b.dueAt) return a.ref.localeCompare(b.ref);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });

  const truncatedKinds: ScheduledKind[] = [];
  if (messages.length >= PER_KIND_LIMIT) truncatedKinds.push('MESSAGE');
  if (jobs.length >= PER_KIND_LIMIT) truncatedKinds.push('JOB');
  if (cadence.length >= PER_KIND_LIMIT) truncatedKinds.push('CADENCE');
  if (goals.length >= PER_KIND_LIMIT) truncatedKinds.push('GOAL');
  if (reminders.length >= PER_KIND_LIMIT) truncatedKinds.push('REMINDER');

  const start = Math.max(0, (page - 1) * pageSize);
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
    truncatedKinds,
  };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

type MessageRow = Prisma.MessageGetPayload<{
  include: {
    conversation: {
      select: {
        id: true;
        channel: true;
        subject: true;
        lead: { select: { id: true; companyName: true; doNotContact: true; contactReviewReason: true } };
        contact: { select: { email: true; optedOut: true; emailStatus: true } };
      };
    };
    campaign: { select: { id: true; name: true; status: true; mode: true } };
  };
}>;

function messageItem(m: MessageRow, now: Date): ScheduledItem {
  const state: ScheduledState =
    m.status === 'paused'
      ? 'PAUSED'
      : m.status === 'sending'
        ? 'RUNNING'
        : m.status === 'draft_pending_approval'
          ? 'NEEDS_APPROVAL'
          : m.scheduledAt && m.scheduledAt > now
            ? 'SCHEDULED'
            : 'DUE';

  const lead = m.conversation.lead;
  const contact = m.conversation.contact;
  const blockedReason = lead.doNotContact
    ? `${lead.companyName} has opted out — the queue will cancel this instead of sending it`
    : contact?.optedOut || contact?.emailStatus
      ? `${contact.email} is ${contact.emailStatus || 'opted out'} — the queue will cancel this`
      : lead.contactReviewReason
        ? `Lead is on hold: ${lead.contactReviewReason}`
        : m.campaign && m.campaign.status !== 'ACTIVE'
          ? `Campaign "${m.campaign.name}" is ${m.campaign.status.toLowerCase()} — this is held until it is active again`
          : null;

  const expiresAt = new Date(m.createdAt.getTime() + QUEUE_MAX_AGE_MS);

  return {
    ref: `MESSAGE:${m.id}`,
    kind: 'MESSAGE',
    state,
    dueAt: m.scheduledAt?.toISOString() ?? null,
    channel: m.conversation.channel,
    title:
      state === 'NEEDS_APPROVAL'
        ? `Draft awaiting your approval — ${lead.companyName}`
        : `Email to ${contact?.email || lead.companyName}: "${m.subject || m.conversation.subject || 'Following up'}"`,
    detail: clip(m.body, 600),
    lead: { id: lead.id, companyName: lead.companyName },
    campaign: m.campaign ? { id: m.campaign.id, name: m.campaign.name } : null,
    blockedReason,
    expiresAt: expiresAt.toISOString(),
    meta: {
      conversationId: m.conversation.id,
      subject: m.subject || m.conversation.subject,
      senderName: m.senderName,
      composedAt: m.createdAt.toISOString(),
      expired: expiresAt <= now,
    },
    actions: {
      pause: state === 'DUE' || state === 'SCHEDULED',
      resume: state === 'PAUSED',
      cancel: state !== 'RUNNING',
    },
  };
}

type JobRow = Prisma.AgentJobGetPayload<{
  include: {
    lead: { select: { id: true; companyName: true; doNotContact: true } };
    campaign: { select: { id: true; name: true } };
  };
}>;

const JOB_LABELS: Record<string, string> = {
  FOLLOW_UP: 'Follow-up',
  RESEARCH: 'Research',
  CAMPAIGN_STEP: 'Campaign touch',
  CUSTOM: 'Task',
};

function jobItem(j: JobRow): ScheduledItem {
  const state: ScheduledState =
    j.status === 'PAUSED'
      ? 'PAUSED'
      : j.status === 'RUNNING'
        ? 'RUNNING'
        : j.runAt > new Date()
          ? 'SCHEDULED'
          : 'DUE';

  return {
    ref: `JOB:${j.id}`,
    kind: 'JOB',
    state,
    dueAt: j.runAt.toISOString(),
    channel: null,
    title:
      `${JOB_LABELS[j.type] || j.type} · ${j.role}` +
      (j.lead ? ` — ${j.lead.companyName}` : j.campaign ? ` — ${j.campaign.name}` : ''),
    detail: clip(j.objective, 600),
    lead: j.lead ? { id: j.lead.id, companyName: j.lead.companyName } : null,
    campaign: j.campaign ? { id: j.campaign.id, name: j.campaign.name } : null,
    blockedReason: j.lead?.doNotContact
      ? `${j.lead.companyName} has opted out — the agent is barred from contacting them`
      : null,
    expiresAt: null,
    meta: {
      type: j.type,
      role: j.role,
      attempts: j.attempts,
      lastError: j.lastError,
      // A job that exists because a campaign told it to will simply be recreated
      // if the campaign's cadence is left running.
      fromCadence: j.type === 'CAMPAIGN_STEP',
    },
    actions: {
      pause: state === 'DUE' || state === 'SCHEDULED',
      resume: state === 'PAUSED',
      // A running agent is stopped from the Live page, at a step boundary.
      cancel: state !== 'RUNNING',
    },
  };
}

type CadenceRow = Prisma.CampaignLeadGetPayload<{
  include: {
    lead: { select: { id: true; companyName: true; doNotContact: true; contactReviewReason: true } };
  };
}>;

function cadenceItem(
  cl: CadenceRow,
  campaign: { id: string; name: string; status: string; mode: string; maxTouches: number; channels: string[] },
  now: Date
): ScheduledItem {
  const state: ScheduledState = cl.pausedAt
    ? 'PAUSED'
    : cl.nextTouchAt && cl.nextTouchAt > now
      ? 'SCHEDULED'
      : 'DUE';

  const blockedReason = cl.lead.doNotContact
    ? `${cl.lead.companyName} has opted out — the sweep skips this row`
    : cl.lead.contactReviewReason
      ? `On hold: ${cl.lead.contactReviewReason}`
      : campaign.status !== 'ACTIVE'
        ? `Campaign is ${campaign.status.toLowerCase()} — no touches go out while it is`
        : null;

  const remaining = Math.max(0, campaign.maxTouches - cl.touchCount);

  return {
    ref: `CADENCE:${cl.id}`,
    kind: 'CADENCE',
    state,
    dueAt: cl.nextTouchAt?.toISOString() ?? null,
    channel: campaign.channels.join(', ') || null,
    title: `Campaign touch ${cl.touchCount + 1}/${campaign.maxTouches} — ${cl.lead.companyName}`,
    detail:
      `"${campaign.name}" will compose and send touch ${cl.touchCount + 1} of ${campaign.maxTouches}` +
      (cl.cycle > 1 ? ` (pass ${cl.cycle})` : '') +
      `. ${remaining} touch${remaining === 1 ? '' : 'es'} left after this one. This row REGENERATES: ` +
      'while it is live the sweep writes a fresh message every time the touch falls due, so cancelling ' +
      'an individual email does not stop it — hold or remove the row itself.',
    lead: { id: cl.lead.id, companyName: cl.lead.companyName },
    campaign: { id: campaign.id, name: campaign.name },
    blockedReason,
    expiresAt: null,
    meta: {
      touchCount: cl.touchCount,
      maxTouches: campaign.maxTouches,
      cycle: cl.cycle,
      sequenceStatus: cl.status,
      lastTouchAt: cl.lastTouchAt?.toISOString() ?? null,
      pausedAt: cl.pausedAt?.toISOString() ?? null,
      generator: true,
      approvalRequired: campaign.mode === 'APPROVAL_REQUIRED',
    },
    actions: { pause: !cl.pausedAt, resume: !!cl.pausedAt, cancel: true },
  };
}

type GoalRow = Prisma.AutopilotGoalGetPayload<{ include: { campaign: { select: { id: true; name: true } } } }>;

function goalItem(g: GoalRow): ScheduledItem {
  const state: ScheduledState =
    g.status === 'PAUSED' ? 'PAUSED' : g.nextRunAt > new Date() ? 'SCHEDULED' : 'DUE';

  return {
    ref: `GOAL:${g.id}`,
    kind: 'GOAL',
    state,
    dueAt: g.nextRunAt.toISOString(),
    channel: null,
    title: `Autopilot goal · ${g.name}`,
    detail:
      `Re-queues a ${g.role} job every ${g.cadenceHours}h until it completes. This REGENERATES: ` +
      'cancelling the jobs it has already created does not stop it producing more.\n\n' +
      clip(g.objective, 400),
    lead: null,
    campaign: g.campaign ? { id: g.campaign.id, name: g.campaign.name } : null,
    blockedReason: null,
    expiresAt: null,
    meta: {
      cadenceHours: g.cadenceHours,
      targetLeadCount: g.targetLeadCount,
      lastQueuedAt: g.lastQueuedAt?.toISOString() ?? null,
      lastResult: g.lastResult,
      generator: true,
    },
    actions: { pause: g.status === 'ACTIVE', resume: g.status === 'PAUSED', cancel: true },
  };
}

type ReminderRow = Prisma.CalendarEventGetPayload<{
  include: {
    lead: { select: { id: true; companyName: true; doNotContact: true } };
    contact: { select: { email: true; optedOut: true; emailStatus: true } };
  };
}>;

/** Zero or one row: the NEXT reminder still owed on this meeting. */
function reminderItem(e: ReminderRow, now: Date): ScheduledItem[] {
  const already = Array.isArray(e.remindersSent) ? (e.remindersSent as string[]) : [];
  // Earliest-firing rule that has not gone yet. 24h is listed first, so the
  // find below naturally returns the one that fires soonest.
  const next = REMINDER_RULES.find((r) => !already.includes(r.key));
  if (!next) return [];

  const dueAt = new Date(e.startAt.getTime() - next.leadMs);
  const state: ScheduledState = dueAt <= now ? 'DUE' : 'SCHEDULED';

  return [
    {
      ref: `REMINDER:${e.id}`,
      kind: 'REMINDER',
      state,
      channel: 'EMAIL',
      dueAt: dueAt.toISOString(),
      title: `Meeting reminder (${next.label}) — ${e.lead?.companyName || e.title}`,
      detail:
        `An automatic reminder for "${e.title}" on ${e.startAt.toUTCString()}, emailed to the lead ` +
        `${next.label} and again 1h before if that has not gone yet. Cancelling here suppresses every ` +
        'reminder left on this meeting; the meeting itself stays booked.',
      lead: e.lead ? { id: e.lead.id, companyName: e.lead.companyName } : null,
      campaign: null,
      blockedReason: e.lead?.doNotContact
        ? `${e.lead.companyName} has opted out — the reminder email is suppressed`
        : !e.contact?.email
          ? 'No contact email — only the in-app notification fires'
          : null,
      expiresAt: null,
      meta: {
        startAt: e.startAt.toISOString(),
        remindersSent: already,
        remindersLeft: REMINDER_RULES.filter((r) => !already.includes(r.key)).map((r) => r.label),
      },
      // Nothing to hold: a reminder is pinned to the meeting time, so a pause
      // that outlived the meeting would be indistinguishable from a cancel.
      actions: { pause: false, resume: false, cancel: true },
    },
  ];
}

// ---------------------------------------------------------------------------
// Summary — the counts, and the answer to "why is it still going out?"
// ---------------------------------------------------------------------------

export interface ScheduledSummary {
  /** Fires with no human involved. The number that matters. */
  automatic: number;
  /** Waiting on a person; will never send by itself. */
  awaitingYou: number;
  paused: number;
  dueWithin24h: number;
  byKind: { kind: ScheduledKind; total: number; due: number; paused: number }[];
  /** Layers that CREATE new work. Stopping these is what actually stops sends. */
  generators: {
    campaigns: {
      id: string;
      name: string;
      status: string;
      liveLeads: number;
      pausedLeads: number;
      dormantLeads: number;
      followUpCadenceDays: number;
      maxTouches: number;
      reEngageAfterDays: number | null;
    }[];
    activeGoals: { id: string; name: string; cadenceHours: number; nextRunAt: string }[];
  };
  /** Org-wide kill switch state, so the page can say whether anything can send. */
  orgPaused: boolean;
}

export async function scheduledSummary(organizationId: string): Promise<ScheduledSummary> {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 3600 * 1000);
  const base: ScheduledFilter = { organizationId };
  const campaigns = await cadenceCampaigns(organizationId);

  const cadenceAll = campaigns.length ? cadenceWhere(base, now, campaigns) : { id: '__none__' };

  const [
    org,
    msgDue,
    msgScheduled,
    msgPaused,
    msgApproval,
    msgSoon,
    jobDue,
    jobScheduled,
    jobPaused,
    jobSoon,
    cadenceDue,
    cadenceScheduled,
    cadencePaused,
    cadenceSoon,
    goalDue,
    goalScheduled,
    goalPaused,
    goalSoon,
    reminders,
    dormantByCampaign,
    activeGoals,
    liveByCampaign,
    pausedByCampaign,
  ] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { paused: true } }),
    prisma.message.count({ where: messageWhere({ ...base, states: ['DUE'] }, now) }),
    prisma.message.count({ where: messageWhere({ ...base, states: ['SCHEDULED'] }, now) }),
    prisma.message.count({ where: messageWhere({ ...base, states: ['PAUSED'] }, now) }),
    prisma.message.count({ where: messageWhere({ ...base, states: ['NEEDS_APPROVAL'] }, now) }),
    prisma.message.count({
      where: messageWhere({ ...base, states: ['DUE', 'SCHEDULED'], withinHours: 24 }, now),
    }),
    prisma.agentJob.count({ where: jobWhere({ ...base, states: ['DUE'] }, now) }),
    prisma.agentJob.count({ where: jobWhere({ ...base, states: ['SCHEDULED'] }, now) }),
    prisma.agentJob.count({ where: jobWhere({ ...base, states: ['PAUSED'] }, now) }),
    prisma.agentJob.count({ where: jobWhere({ ...base, states: ['DUE', 'SCHEDULED'], withinHours: 24 }, now) }),
    campaigns.length
      ? prisma.campaignLead.count({ where: cadenceWhere({ ...base, states: ['DUE'] }, now, campaigns) })
      : 0,
    campaigns.length
      ? prisma.campaignLead.count({ where: cadenceWhere({ ...base, states: ['SCHEDULED'] }, now, campaigns) })
      : 0,
    campaigns.length
      ? prisma.campaignLead.count({ where: cadenceWhere({ ...base, states: ['PAUSED'] }, now, campaigns) })
      : 0,
    campaigns.length
      ? prisma.campaignLead.count({
          where: cadenceWhere({ ...base, states: ['DUE', 'SCHEDULED'], withinHours: 24 }, now, campaigns),
        })
      : 0,
    prisma.autopilotGoal.count({ where: goalWhere({ ...base, states: ['DUE'] }, now) }),
    prisma.autopilotGoal.count({ where: goalWhere({ ...base, states: ['SCHEDULED'] }, now) }),
    prisma.autopilotGoal.count({ where: goalWhere({ ...base, states: ['PAUSED'] }, now) }),
    prisma.autopilotGoal.count({
      where: goalWhere({ ...base, states: ['DUE', 'SCHEDULED'], withinHours: 24 }, now),
    }),
    // Reminders are counted from rows, because "does it still owe one" lives in
    // a JSON column that SQL here cannot filter on.
    prisma.calendarEvent.findMany({
      where: reminderWhere(base, now),
      select: { startAt: true, remindersSent: true },
      take: 1000,
    }),
    prisma.campaignLead.groupBy({
      by: ['campaignId'],
      where: { campaign: { organizationId }, status: 'COMPLETED' },
      _count: { _all: true },
    }),
    prisma.autopilotGoal.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, name: true, cadenceHours: true, nextRunAt: true },
      orderBy: { nextRunAt: 'asc' },
      take: 50,
    }),
    campaigns.length
      ? prisma.campaignLead.groupBy({
          by: ['campaignId'],
          where: { AND: [cadenceAll, { pausedAt: null }] },
          _count: { _all: true },
        })
      : [],
    campaigns.length
      ? prisma.campaignLead.groupBy({
          by: ['campaignId'],
          where: { AND: [cadenceAll, { pausedAt: { not: null } }] },
          _count: { _all: true },
        })
      : [],
  ]);

  const owed = reminders.filter((e) => {
    const already = Array.isArray(e.remindersSent) ? (e.remindersSent as string[]) : [];
    return REMINDER_RULES.some((r) => !already.includes(r.key));
  });
  const reminderDue = owed.filter((e) => {
    const already = Array.isArray(e.remindersSent) ? (e.remindersSent as string[]) : [];
    const next = REMINDER_RULES.find((r) => !already.includes(r.key));
    return !!next && e.startAt.getTime() - next.leadMs <= now.getTime();
  }).length;
  const reminderSoon = owed.filter((e) => {
    const already = Array.isArray(e.remindersSent) ? (e.remindersSent as string[]) : [];
    const next = REMINDER_RULES.find((r) => !already.includes(r.key));
    return !!next && e.startAt.getTime() - next.leadMs <= soon.getTime();
  }).length;

  const liveById = new Map(liveByCampaign.map((r) => [r.campaignId, r._count._all]));
  const pausedById = new Map(pausedByCampaign.map((r) => [r.campaignId, r._count._all]));
  const dormantById = new Map(dormantByCampaign.map((r) => [r.campaignId, r._count._all]));

  const fullCampaigns = await prisma.campaign.findMany({
    where: { id: { in: campaigns.map((c) => c.id) } },
    select: {
      id: true,
      name: true,
      status: true,
      followUpCadenceDays: true,
      maxTouches: true,
      reEngageAfterDays: true,
    },
  });

  return {
    automatic:
      msgDue + msgScheduled + jobDue + jobScheduled + cadenceDue + cadenceScheduled + goalDue + goalScheduled + owed.length,
    awaitingYou: msgApproval,
    paused: msgPaused + jobPaused + cadencePaused + goalPaused,
    dueWithin24h: msgSoon + jobSoon + cadenceSoon + goalSoon + reminderSoon,
    byKind: [
      { kind: 'MESSAGE', total: msgDue + msgScheduled + msgPaused, due: msgDue, paused: msgPaused },
      { kind: 'JOB', total: jobDue + jobScheduled + jobPaused, due: jobDue, paused: jobPaused },
      { kind: 'CADENCE', total: cadenceDue + cadenceScheduled + cadencePaused, due: cadenceDue, paused: cadencePaused },
      { kind: 'GOAL', total: goalDue + goalScheduled + goalPaused, due: goalDue, paused: goalPaused },
      { kind: 'REMINDER', total: owed.length, due: reminderDue, paused: 0 },
    ],
    generators: {
      campaigns: fullCampaigns
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          liveLeads: liveById.get(c.id) ?? 0,
          pausedLeads: pausedById.get(c.id) ?? 0,
          dormantLeads: dormantById.get(c.id) ?? 0,
          followUpCadenceDays: c.followUpCadenceDays,
          maxTouches: c.maxTouches,
          reEngageAfterDays: c.reEngageAfterDays,
        }))
        .sort((a, b) => b.liveLeads - a.liveLeads),
      activeGoals: activeGoals.map((g) => ({
        id: g.id,
        name: g.name,
        cadenceHours: g.cadenceHours,
        nextRunAt: g.nextRunAt.toISOString(),
      })),
    },
    orgPaused: !!org?.paused,
  };
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

export interface ActionResult {
  action: ScheduledAction;
  applied: number;
  byKind: Partial<Record<ScheduledKind, number>>;
  /** Rows that could not take the action, with the reason, never silently dropped. */
  skipped: { ref: string; reason: string }[];
  notes: string[];
}

const RESUMABLE_MESSAGE = { status: 'paused' } as const;

/**
 * Apply an action to an explicit set of refs.
 *
 * Every write is scoped to the organization inside its own predicate, so an id
 * from another tenant matches nothing rather than being trusted because it
 * appeared in the list.
 */
export async function applyToRefs(
  organizationId: string,
  action: ScheduledAction,
  refs: string[]
): Promise<ActionResult> {
  const result: ActionResult = { action, applied: 0, byKind: {}, skipped: [], notes: [] };
  const byKind = new Map<ScheduledKind, string[]>();

  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!parsed) {
      result.skipped.push({ ref, reason: 'Unrecognized reference' });
      continue;
    }
    const list = byKind.get(parsed.kind);
    if (list) list.push(parsed.id);
    else byKind.set(parsed.kind, [parsed.id]);
  }

  for (const [kind, ids] of byKind) {
    const count = await applyKind(organizationId, kind, action, { ids }, result);
    if (count > 0) {
      result.byKind[kind] = (result.byKind[kind] ?? 0) + count;
      result.applied += count;
    }
    if (count < ids.length && !result.skipped.some((s) => s.ref.startsWith(`${kind}:`))) {
      result.skipped.push({
        ref: `${kind}:*`,
        reason: `${ids.length - count} ${kind.toLowerCase()} row(s) had already moved on and were left alone`,
      });
    }
  }
  return result;
}

/**
 * Apply an action to EVERYTHING matching a filter, without listing ids first.
 *
 * This is the difference between "pause the fifty rows on this page" and "pause
 * the campaign", and it is the whole point of the bulk controls: the operator
 * who has 4,000 due touches needs one action, not eighty pages of them.
 */
export async function applyToFilter(
  organizationId: string,
  action: ScheduledAction,
  filter: ScheduledFilter
): Promise<ActionResult> {
  const result: ActionResult = { action, applied: 0, byKind: {}, skipped: [], notes: [] };
  const kinds = filter.kinds?.length ? filter.kinds : ALL_KINDS;

  for (const kind of kinds) {
    const count = await applyKind(organizationId, kind, action, { filter }, result);
    if (count > 0) {
      result.byKind[kind] = count;
      result.applied += count;
    }
  }
  return result;
}

async function applyKind(
  organizationId: string,
  kind: ScheduledKind,
  action: ScheduledAction,
  target: { ids?: string[]; filter?: ScheduledFilter },
  result: ActionResult
): Promise<number> {
  const now = new Date();
  const scoped: ScheduledFilter = target.filter
    ? { ...target.filter, organizationId }
    : { organizationId };

  switch (kind) {
    case 'MESSAGE': {
      const base: Prisma.MessageWhereInput = target.ids
        ? { id: { in: target.ids }, conversation: { organizationId } }
        : messageWhere(scoped, now);

      if (action === 'pause') {
        const { count } = await prisma.message.updateMany({
          where: { AND: [base, { status: 'scheduled' }] },
          data: { status: 'paused' },
        });
        return count;
      }
      if (action === 'resume') {
        // A held message keeps ageing. Say how many are already past the queue's
        // three-day cut-off rather than letting them silently expire on resume.
        const stale = await prisma.message.count({
          where: {
            AND: [base, RESUMABLE_MESSAGE, { createdAt: { lt: new Date(now.getTime() - QUEUE_MAX_AGE_MS) } }],
          },
        });
        const { count } = await prisma.message.updateMany({
          where: { AND: [base, RESUMABLE_MESSAGE] },
          // Anything whose due time has passed goes out on the next sweep.
          data: { status: 'scheduled' },
        });
        if (stale > 0) {
          result.notes.push(
            `${stale} resumed message(s) were written more than 3 days ago and will be dropped as stale ` +
              'rather than sent — the queue expires old mail so a prospect never gets a message about an ' +
              'offer that has moved on. Ask the Engine to rewrite those.'
          );
        }
        return count;
      }
      // Cancel: keep the row as a record rather than deleting it, and never
      // touch one the drain has already claimed.
      const doomed = await prisma.message.findMany({
        where: { AND: [base, { status: { in: ['scheduled', 'paused', 'draft_pending_approval'] } }] },
        select: { id: true, conversation: { select: { organizationId: true, leadId: true } } },
        take: 5000,
      });
      if (doomed.length === 0) return 0;
      const { count } = await prisma.message.updateMany({
        where: {
          id: { in: doomed.map((d) => d.id) },
          status: { in: ['scheduled', 'paused', 'draft_pending_approval'] },
        },
        data: { status: 'cancelled', scheduledAt: null },
      });
      // A send that never happened still belongs on the lead's timeline —
      // otherwise the record shows a gap no one can explain later.
      for (const d of doomed) {
        await leadService
          .logActivity({
            organizationId: d.conversation.organizationId,
            leadId: d.conversation.leadId,
            type: 'STATUS_CHANGE',
            summary: 'Queued message cancelled by an operator before it was sent.',
            payload: { messageId: d.id, outcome: 'cancelled', source: 'scheduled-page' },
          })
          .catch(() => undefined);
      }
      return count;
    }

    case 'JOB': {
      const base: Prisma.AgentJobWhereInput = target.ids
        ? { id: { in: target.ids }, organizationId }
        : jobWhere(scoped, now);

      if (action === 'pause') {
        const { count } = await prisma.agentJob.updateMany({
          where: { AND: [base, { status: 'PENDING' }] },
          data: { status: 'PAUSED' },
        });
        return count;
      }
      if (action === 'resume') {
        const { count } = await prisma.agentJob.updateMany({
          where: { AND: [base, { status: 'PAUSED' }] },
          data: { status: 'PENDING' },
        });
        return count;
      }
      const { count } = await prisma.agentJob.updateMany({
        where: { AND: [base, { status: { in: ['PENDING', 'PAUSED'] } }] },
        data: { status: 'CANCELLED', lastError: 'Cancelled by an operator' },
      });
      return count;
    }

    case 'CADENCE': {
      const campaigns = await cadenceCampaigns(organizationId, scoped.campaignId);
      const base: Prisma.CampaignLeadWhereInput = target.ids
        ? { id: { in: target.ids }, campaign: { organizationId } }
        : campaigns.length
          ? cadenceWhere(scoped, now, campaigns)
          : { id: '__none__' };

      if (action === 'pause') {
        const { count } = await prisma.campaignLead.updateMany({
          where: { AND: [base, { pausedAt: null }] },
          data: { pausedAt: now },
        });
        if (count > 0) {
          result.notes.push(
            `${count} campaign lead(s) held. The cadence sweep now skips them, so no new touches are ` +
              'composed for these leads until they are resumed.'
          );
        }
        return count;
      }
      if (action === 'resume') {
        const { count } = await prisma.campaignLead.updateMany({
          where: { AND: [base, { pausedAt: { not: null } }] },
          data: { pausedAt: null },
        });
        return count;
      }
      // Cancelling a cadence row means leaving the sequence for good. REMOVED is
      // outside every status the sweep looks at, so it can never be revived by
      // the dormant-lead pass either.
      const { count } = await prisma.campaignLead.updateMany({
        where: { AND: [base, { status: { in: ['PENDING', 'IN_SEQUENCE'] } }] },
        data: { status: 'REMOVED', pausedAt: null, nextTouchAt: null },
      });
      if (count > 0) {
        result.notes.push(
          `${count} lead(s) removed from their campaign sequence permanently. Re-enroll them from the ` +
            'campaign if you change your mind — a hold would have been reversible.'
        );
      }
      return count;
    }

    case 'GOAL': {
      const base: Prisma.AutopilotGoalWhereInput = target.ids
        ? { id: { in: target.ids }, organizationId }
        : goalWhere(scoped, now);

      if (action === 'pause') {
        const { count } = await prisma.autopilotGoal.updateMany({
          where: { AND: [base, { status: 'ACTIVE' }] },
          data: { status: 'PAUSED' },
        });
        return count;
      }
      if (action === 'resume') {
        const { count } = await prisma.autopilotGoal.updateMany({
          where: { AND: [base, { status: 'PAUSED' }] },
          // Due immediately on resume would fire a paid run the same second.
          data: { status: 'ACTIVE', nextRunAt: now },
        });
        return count;
      }
      const { count } = await prisma.autopilotGoal.updateMany({
        where: { AND: [base, { status: { in: ['ACTIVE', 'PAUSED'] } }] },
        data: { status: 'CANCELLED' },
      });
      return count;
    }

    case 'REMINDER': {
      if (action !== 'cancel') {
        result.skipped.push({
          ref: 'REMINDER:*',
          reason:
            'A meeting reminder is pinned to the meeting time and cannot be held — cancel it, or move the meeting.',
        });
        return 0;
      }
      const base: Prisma.CalendarEventWhereInput = target.ids
        ? { id: { in: target.ids }, organizationId }
        : reminderWhere(scoped, now);
      const events = await prisma.calendarEvent.findMany({
        where: { AND: [base, { status: 'SCHEDULED' }] },
        select: { id: true, remindersSent: true },
        take: 5000,
      });
      let count = 0;
      for (const e of events) {
        const already = Array.isArray(e.remindersSent) ? (e.remindersSent as string[]) : [];
        const keys = REMINDER_RULES.map((r) => r.key);
        if (keys.every((k) => already.includes(k))) continue;
        // Marking every rule as already sent is how the sweep is told to skip
        // this meeting — there is no separate "suppressed" flag to set.
        await prisma.calendarEvent
          .update({ where: { id: e.id }, data: { remindersSent: [...new Set([...already, ...keys])] } })
          .catch(() => undefined);
        count++;
      }
      if (count > 0) {
        result.notes.push(
          `Reminders suppressed on ${count} meeting(s). The meetings are still booked — only the automatic ` +
            'lead-facing reminder emails were stopped.'
        );
      }
      return count;
    }
  }
}
