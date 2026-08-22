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
