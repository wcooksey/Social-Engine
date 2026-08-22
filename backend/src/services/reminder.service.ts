import { prisma } from '../config/database';
import * as channels from './channels.service';
import { notify, sendDailyDigest } from './notification.service';
import { resolveSender } from './sender.service';

/**
 * Time-driven sweeps run by the engine worker:
 *  - meeting reminders: nudge the lead 24h and 1h before a booked meeting so
 *    no-shows don't eat autopiloted bookings.
 *  - daily digest: once per day, email each org a summary of what ran.
 */

interface ReminderRule {
  key: string; // stored in remindersSent
  leadMs: number; // fire when the event starts within this many ms
  label: string;
}
const RULES: ReminderRule[] = [
  { key: '24h', leadMs: 24 * 60 * 60 * 1000, label: 'tomorrow' },
  { key: '1h', leadMs: 60 * 60 * 1000, label: 'in about an hour' },
];

export async function runReminderSweep(): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 60 * 1000);
  const events = await prisma.calendarEvent.findMany({
    where: {
      status: 'SCHEDULED',
      startAt: { gt: now, lte: horizon },
      leadId: { not: null },
    },
    include: {
      lead: true,
      contact: true,
      organization: { select: { name: true } },
    },
    take: 200,
  });

  let sent = 0;
  for (const event of events) {
    const already = Array.isArray(event.remindersSent) ? (event.remindersSent as string[]) : [];
    const msUntil = event.startAt.getTime() - now.getTime();
    // The most urgent rule whose window we've entered and haven't sent yet.
    const due = RULES.find((r) => msUntil <= r.leadMs && !already.includes(r.key));
    if (!due) continue;
    if (event.lead?.doNotContact) {
      // Don't message opted-out leads, but mark so we don't retry every sweep.
      await prisma.calendarEvent.update({
        where: { id: event.id },
        data: { remindersSent: [...already, due.key] },
      });
      continue;
    }

    // In-app notification for the team.
    await notify({
      organizationId: event.organizationId,
      type: 'MEETING_REMINDER',
      title: `Upcoming: ${event.title}`,
      body: `Starts ${due.label} (${event.startAt.toUTCString()}).`,
      leadId: event.leadId || undefined,
    });

    // Transactional reminder email to the lead, if we have an address + creds.
    const email = event.contact?.email;
    if (email && !event.contact?.optedOut && !event.contact?.emailStatus) {
      const sender = await resolveSender(event.organizationId, { purpose: 'TRANSACTIONAL' });
      if (sender) {
        const first = event.contact?.firstName || 'there';
        await channels
          .sendEmail(
            {
              to: email,
              subject: `Reminder: ${event.title} ${due.label}`,
              body: `Hi ${first},\n\nThis is a friendly reminder about "${event.title}" scheduled for ${event.startAt.toUTCString()}.\n\nLooking forward to it!\n\n— ${event.organization?.name || 'The team'}`,
              fromName: event.organization?.name,
              fromEmail: sender.fromEmail,
            },
            sender.creds
          )
          .catch(() => undefined);
      }
    }

    await prisma.calendarEvent.update({
      where: { id: event.id },
      data: { remindersSent: [...already, due.key] },
    });
    sent++;
  }
  return sent;
}

/**
 * Close out meetings whose time has passed.
 *
 * A booked demo is the highest-intent outcome the platform produces, and until
 * now nothing happened after the one-hour reminder: no-shows got no re-book
 * attempt and no alert, and because the lead's campaign rows were already
 * retired on reply, no cadence ever touched it again. A booked meeting that
 * nobody attended was simply the end of that lead.
 *
 * Grace period rather than exact end time, so a meeting that ran long isn't
 * flagged while it is still happening.
 */
const MEETING_GRACE_MS = 2 * 60 * 60 * 1000;

export async function runMeetingOutcomeSweep(now: Date = new Date()): Promise<number> {
  const due = await prisma.calendarEvent.findMany({
    where: {
      status: 'SCHEDULED',
      type: 'MEETING',
      startAt: { lt: new Date(now.getTime() - MEETING_GRACE_MS) },
    },
    include: { lead: { select: { id: true, companyName: true, doNotContact: true } } },
    take: 100,
  });

  let handled = 0;
  for (const event of due) {
    // Conditional, so two workers sweeping at once can't both chase it.
    const claimed = await prisma.calendarEvent.updateMany({
      where: { id: event.id, status: 'SCHEDULED' },
      data: { status: 'NO_SHOW' },
    });
    if (claimed.count === 0) continue;
    handled++;

    if (!event.leadId || !event.lead) continue;

    await prisma.activity
      .create({
        data: {
          organizationId: event.organizationId,
          leadId: event.leadId,
          type: 'STATUS_CHANGE',
          summary: `Meeting "${event.title}" passed with no outcome recorded — flagged for follow-up.`,
          payload: { calendarEventId: event.id, outcome: 'no_show' },
        },
      })
      .catch(() => undefined);

    await notify({
      organizationId: event.organizationId,
      type: 'SYSTEM',
      title: `Meeting needs an outcome: ${event.lead.companyName}`,
      body:
        `"${event.title}" was scheduled for ${event.startAt.toUTCString()} and has no outcome. ` +
        'If it happened, mark it completed. If it did not, the Engine has been asked to chase a new time.',
      leadId: event.leadId,
    }).catch(() => undefined);

    // Chasing an opted-out lead would be a compliance breach, not persistence.
    if (event.lead.doNotContact) continue;

    await prisma.agentJob
      .create({
        data: {
          organizationId: event.organizationId,
          leadId: event.leadId,
          type: 'FOLLOW_UP',
          role: 'SDR',
          objective:
            `The meeting "${event.title}" with ${event.lead.companyName}, scheduled for ` +
            `${event.startAt.toUTCString()}, has passed with no outcome recorded — most likely a no-show. ` +
            'Read the thread (read_conversation) and send one warm, brief, blame-free message offering ' +
            'to reschedule — assume something came up, never imply they stood you up. If they already ' +
            'rescheduled or told us it happened, do nothing and say so. Do not chase more than once.',
          runAt: new Date(now.getTime() + 60 * 60 * 1000),
        },
      })
      .catch(() => undefined);
  }
  return handled;
}

// Daily digest throttle: run once per calendar day (UTC) at/after DIGEST_HOUR.
// In-memory guard is fine — a missed day on restart is harmless.
const DIGEST_HOUR_UTC = 13; // ~8-9am US business hours
let lastDigestDay = '';

export async function runDigestSweepIfDue(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() < DIGEST_HOUR_UTC) return;
  const dayKey = now.toISOString().slice(0, 10);
  if (dayKey === lastDigestDay) return;
  lastDigestDay = dayKey;

  const orgs = await prisma.organization.findMany({ where: { paused: false }, select: { id: true } });
  for (const org of orgs) {
    await sendDailyDigest(org.id).catch(() => undefined);
  }
}
