/**
 * Everything the platform will do on its own, normalized across the five
 * mechanisms that can send without anyone pressing a button. Mirrors
 * `backend/src/services/scheduled.service.ts`.
 */

export type ScheduledKind = 'MESSAGE' | 'JOB' | 'CADENCE' | 'GOAL' | 'REMINDER';

export type ScheduledState = 'DUE' | 'SCHEDULED' | 'PAUSED' | 'RUNNING' | 'NEEDS_APPROVAL';

export type ScheduledAction = 'pause' | 'resume' | 'cancel';

export interface ScheduledItem {
  /** `KIND:uuid` — a selection can span every mechanism at once. */
  ref: string;
  kind: ScheduledKind;
  state: ScheduledState;
  dueAt: string | null;
  channel: string | null;
  title: string;
  detail: string | null;
  lead: { id: string; companyName: string } | null;
  campaign: { id: string; name: string } | null;
  /** Why this won't send even though it is scheduled (opt-out, hold, paused campaign). */
  blockedReason: string | null;
  expiresAt: string | null;
  meta: Record<string, unknown>;
  actions: { pause: boolean; resume: boolean; cancel: boolean };
}

export interface ScheduledPage {
  items: ScheduledItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Kinds whose read hit the server cap — the list isn't the whole story. */
  truncatedKinds: ScheduledKind[];
}

export interface GeneratorCampaign {
  id: string;
  name: string;
  status: string;
  /** Leads still being worked — every one of these produces new touches. */
  liveLeads: number;
  pausedLeads: number;
  dormantLeads: number;
  followUpCadenceDays: number;
  maxTouches: number;
  reEngageAfterDays: number | null;
}

export interface GeneratorGoal {
  id: string;
  name: string;
  cadenceHours: number;
  nextRunAt: string;
}

export interface ScheduledSummary {
  /** Fires with no human involved. */
  automatic: number;
  /** Waiting on a person; will never send by itself. */
  awaitingYou: number;
  paused: number;
  dueWithin24h: number;
  byKind: { kind: ScheduledKind; total: number; due: number; paused: number }[];
  generators: { campaigns: GeneratorCampaign[]; activeGoals: GeneratorGoal[] };
  orgPaused: boolean;
}

export interface ScheduledActionResult {
  action: ScheduledAction;
  applied: number;
  byKind: Partial<Record<ScheduledKind, number>>;
  skipped: { ref: string; reason: string }[];
  notes: string[];
}

export interface ScheduledQuery {
  kind?: ScheduledKind[];
  state?: ScheduledState[];
  campaignId?: string;
  leadId?: string;
  q?: string;
  withinHours?: number;
}

/** How each mechanism reads to a person, and whether it makes more work. */
export const KIND_META: Record<
  ScheduledKind,
  { label: string; short: string; icon: string; generator: boolean; blurb: string }
> = {
  MESSAGE: {
    label: 'Queued message',
    short: 'Messages',
    icon: 'bi-envelope-paper',
    generator: false,
    blurb:
      'An email that is already written and waiting on sender warm-up. It goes out as soon as a mailbox frees up.',
  },
  JOB: {
    label: 'Agent job',
    short: 'Agent jobs',
    icon: 'bi-robot',
    generator: false,
    blurb:
      'Work an agent will wake up and do — a follow-up it scheduled for itself, a batched campaign touch, a no-show chase.',
  },
  CADENCE: {
    label: 'Campaign touch',
    short: 'Campaign touches',
    icon: 'bi-arrow-repeat',
    generator: true,
    blurb:
      'A lead whose next campaign touch is due. This makes NEW messages every few minutes — cancelling the emails it already wrote does not stop it.',
  },
  GOAL: {
    label: 'Autopilot goal',
    short: 'Autopilot goals',
    icon: 'bi-infinity',
    generator: true,
    blurb:
      'A standing objective that re-queues itself on a cadence, indefinitely, until it completes or someone stops it.',
  },
  REMINDER: {
    label: 'Meeting reminder',
    short: 'Meeting reminders',
    icon: 'bi-alarm',
    generator: false,
    blurb: 'The automatic 24h and 1h reminder emails sent to a lead before a booked meeting.',
  },
};

export const STATE_META: Record<ScheduledState, { label: string; variant: string }> = {
  DUE: { label: 'Due now', variant: 'warning' },
  SCHEDULED: { label: 'Scheduled', variant: 'info' },
  PAUSED: { label: 'Held', variant: 'neutral' },
  RUNNING: { label: 'Sending', variant: 'purple' },
  NEEDS_APPROVAL: { label: 'Needs you', variant: 'orange' },
};
