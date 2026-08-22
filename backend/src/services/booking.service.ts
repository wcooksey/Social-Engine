import { prisma } from '../config/database';
import { config } from '../config/environment';
import * as channels from './channels.service';
import { notify } from './notification.service';
import { recomputeLeadEnrichment } from './lead-enrichment.service';
import { buildIcs } from '../utils/ics';
import { resolveSender } from './sender.service';

/**
 * Public self-serve booking: a lead opens a booking link, sees open slots
 * computed from the link's weekly availability (minus already-booked events),
 * and books one. Booking creates the lead/contact if new, drops a CalendarEvent
 * on the shared calendar, emails an .ics invite, and alerts the org.
 */

type Windows = Record<string, [string, string][]>; // ISO weekday "1".."7" → [["09:00","17:00"]]

interface LocalDate {
  y: number;
  mo: number; // 1-12
  d: number;
}

// Offset (ms) of a timezone at a given instant: (local wall clock) − (UTC).
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  }
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour === 24 ? 0 : map.hour, map.minute, map.second);
  return asUTC - date.getTime();
}

// Convert a wall-clock time in `tz` to the corresponding UTC Date.
function zonedToUtc(dl: LocalDate, hour: number, minute: number, tz: string): Date {
  const naiveUTC = Date.UTC(dl.y, dl.mo - 1, dl.d, hour, minute);
  const offset = tzOffsetMs(new Date(naiveUTC), tz);
  return new Date(naiveUTC - offset);
}

function localDateParts(date: Date, tz: string): LocalDate {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  }
  return { y: map.year, mo: map.month, d: map.day };
}

function addDays(dl: LocalDate, n: number): LocalDate {
  const t = Date.UTC(dl.y, dl.mo - 1, dl.d + n);
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function isoWeekday(dl: LocalDate): number {
  const day = new Date(Date.UTC(dl.y, dl.mo - 1, dl.d)).getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

export interface AvailableSlot {
  startIso: string;
  endIso: string;
}

export async function getActiveLink(slug: string) {
  const link = await prisma.bookingLink.findFirst({ where: { slug, active: true } });
  return link;
}

/** Compute open slots for a link over the next `days` days. */
export async function computeSlots(
  link: {
    id: string;
    organizationId: string;
    durationMinutes: number;
    bufferMinutes: number;
    timezone: string;
    availability: unknown;
  },
  days = 14
): Promise<AvailableSlot[]> {
  const windows = (link.availability || {}) as Windows;
  const tz = link.timezone;
  const now = new Date();
  const horizonEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const minLead = 60 * 60 * 1000; // no bookings within the next hour

  // Existing scheduled events in the org to avoid double-booking.
  const busy = await prisma.calendarEvent.findMany({
    where: {
      organizationId: link.organizationId,
      status: 'SCHEDULED',
      startAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), lte: horizonEnd },
    },
    select: { startAt: true, endAt: true },
  });
  const bufferMs = link.bufferMinutes * 60 * 1000;
  const conflicts = (start: Date, end: Date): boolean =>
    busy.some((b) => {
      const bStart = b.startAt.getTime() - bufferMs;
      const bEnd = (b.endAt ?? new Date(b.startAt.getTime() + link.durationMinutes * 60000)).getTime() + bufferMs;
      return start.getTime() < bEnd && end.getTime() > bStart;
    });

  const slots: AvailableSlot[] = [];
  const startLocal = localDateParts(now, tz);
  for (let i = 0; i <= days; i++) {
    const day = addDays(startLocal, i);
    const wd = isoWeekday(day);
    const dayWindows = windows[String(wd)] || [];
    for (const [startHM, endHM] of dayWindows) {
      const endMin = hmToMinutes(endHM);
      let cursor = hmToMinutes(startHM);
      while (cursor + link.durationMinutes <= endMin) {
        const startUtc = zonedToUtc(day, Math.floor(cursor / 60), cursor % 60, tz);
        const endUtc = new Date(startUtc.getTime() + link.durationMinutes * 60000);
        if (
          startUtc.getTime() > now.getTime() + minLead &&
          startUtc <= horizonEnd &&
          !conflicts(startUtc, endUtc)
        ) {
          slots.push({ startIso: startUtc.toISOString(), endIso: endUtc.toISOString() });
        }
        cursor += link.durationMinutes + link.bufferMinutes;
      }
    }
  }
  return slots;
}

export interface BookInput {
  slug: string;
  name: string;
  email: string;
  phone?: string;
  startIso: string;
  notes?: string;
}

export async function book(input: BookInput): Promise<{ eventId: string; startIso: string }> {
  const link = await getActiveLink(input.slug);
  if (!link) throw new Error('This booking link is no longer available.');

  const email = input.email.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('A valid email is required.');
  const name = (input.name || '').trim();
  if (!name) throw new Error('Your name is required.');

  const start = new Date(input.startIso);
  if (isNaN(start.getTime()) || start.getTime() < Date.now()) throw new Error('Please pick a future time.');

  // Re-validate the slot against current availability (guards races / tampering).
  const slots = await computeSlots(link, 21);
  if (!slots.some((s) => s.startIso === start.toISOString())) {
    throw new Error('That time is no longer available — please pick another slot.');
  }
  const end = new Date(start.getTime() + link.durationMinutes * 60000);

  // Find or create the lead + contact by email within the org.
  const orgId = link.organizationId;
  let contact = await prisma.contact.findFirst({
    where: { organizationId: orgId, email },
    include: { lead: true },
  });
  let leadId: string;
  let contactId: string;
  if (contact) {
    leadId = contact.leadId;
    contactId = contact.id;
  } else {
    const [firstName, ...rest] = name.split(/\s+/);
    const lead = await prisma.lead.create({
      data: {
        organizationId: orgId,
        companyName: name,
        source: 'booking_link',
        status: 'INTERESTED', // they booked a meeting — clearly interested
      },
    });
    const created = await prisma.contact.create({
      data: {
        organizationId: orgId,
        leadId: lead.id,
        firstName: firstName || name,
        lastName: rest.join(' ') || null,
        email,
        phone: input.phone?.trim() || null,
        isPrimary: true,
        source: 'booking_link',
      },
    });
    leadId = lead.id;
    contactId = created.id;
    // Self-booked leads arrive with a real person + email attached — score it.
    await recomputeLeadEnrichment(lead.id);
  }

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  const event = await prisma.calendarEvent.create({
    data: {
      organizationId: orgId,
      leadId,
      contactId,
      title: `${link.title} — ${name}`,
      description: input.notes ? `Booked via link.\n\nNotes: ${input.notes}` : 'Booked via link.',
      type: 'MEETING',
      status: 'SCHEDULED',
      startAt: start,
      endAt: end,
      bookingLinkId: link.id,
    },
  });

  await prisma.activity.create({
    data: {
      organizationId: orgId,
      leadId,
      type: 'NOTE',
      summary: `${name} self-booked "${link.title}" for ${start.toISOString()}`,
      payload: { calendarEventId: event.id, bookingLinkId: link.id },
    },
  });

  // Alert the org, and send the booker an .ics invite.
  await notify({
    organizationId: orgId,
    type: 'MEETING_BOOKED',
    title: `New meeting booked: ${name}`,
    body: `${name} booked "${link.title}" for ${start.toUTCString()}.`,
    leadId,
    emailAlert: true,
  });

  // Confirmations go out on a transactional sender, never a cold-outreach one:
  // a domain worn out by prospecting must not be able to take meeting invites
  // down with it.
  const sender = await resolveSender(orgId, { purpose: 'TRANSACTIONAL' });
  if (sender) {
    const ics = buildIcs({
      uid: `${event.id}@social-engine`,
      title: `${link.title} with ${org?.name || 'us'}`,
      description: input.notes || link.description || undefined,
      start,
      end,
      organizerName: org?.name,
      organizerEmail: sender.fromEmail,
      attendeeEmail: email,
      attendeeName: name,
    });
    await channels
      .sendEmail(
        {
          to: email,
          subject: `Confirmed: ${link.title} with ${org?.name || 'us'}`,
          body: `Hi ${name.split(/\s+/)[0]},\n\nYour meeting "${link.title}" is confirmed for ${start.toUTCString()}.\n\nThe calendar invite is attached — add it to your calendar to save the time.\n\nSee you then!`,
          fromName: org?.name,
          fromEmail: sender.fromEmail,
          ics: { filename: 'invite.ics', content: ics },
        },
        sender.creds
      )
      .catch(() => undefined);
  }

  void config; // appPublicUrl reserved for future reschedule links
  return { eventId: event.id, startIso: start.toISOString() };
}
