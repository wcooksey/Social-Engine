import { prisma } from '../config/database';
import { config } from '../config/environment';
import * as channels from './channels.service';
import { deliverEmail, markEmailSent } from './email-delivery.service';
import { resolveSender } from './sender.service';
import { getOrgConfig } from './settings.service';
import { leadService } from './lead.service';
import { computeSlots } from './booking.service';
import { notify } from './notification.service';
import { buildIcs } from '../utils/ics';
import { suppressionReason } from './suppression.service';

/** The org's default booking link — what we text and what we check slots against. */
async function defaultBookingLink(organizationId: string) {
  return prisma.bookingLink.findFirst({
    where: { organizationId, active: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Actions the phone agent can take WHILE it is on the call.
 *
 * "I'll text you the link right now" is only worth saying if it actually
 * happens on the call — a promise fulfilled ten minutes later by a follow-up job
 * has already lost the moment. Vapi calls back to our webhook mid-conversation
 * and speaks the result, so the assistant can text a link, offer real calendar
 * times, book one, or capture a callback without leaving the call.
 *
 * Deliberately narrow: the destination for a text is ALWAYS the number we dialled
 * or the lead's number on file, never one supplied during the conversation. The
 * transcript is untrusted input, and a tool that texts arbitrary numbers on
 * spoken instruction is an open relay.
 */

export type CallToolName =
  | 'send_text_link'
  | 'check_availability'
  | 'book_meeting'
  | 'capture_callback';

/** Vapi tool definitions, sent with the call. */
export function buildCallTools(opts: { hasSms: boolean; hasBookingLink: boolean }): unknown[] {
  const tools: unknown[] = [];

  if (opts.hasSms) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_text_link',
        description:
          "Text a link to the person you are speaking with, right now, while still on the call. Use when they say they'd like to see the demo, want a link, or want to pick a time themselves. The text goes to the number you are calling — you cannot send it anywhere else.",
        parameters: {
          type: 'object',
          properties: {
            link: {
              type: 'string',
              enum: ['demo', 'booking'],
              description: "'demo' = the demo video. 'booking' = a page where they pick a meeting time.",
            },
          },
          required: ['link'],
        },
      },
    });
  }

  // Without a booking link there is no calendar to read or write, so offering
  // these would only let the assistant promise times that don't exist.
  if (opts.hasBookingLink) {
    tools.push({
      type: 'function',
      function: {
        name: 'check_availability',
        description:
          'Get real open meeting times before offering any. Never invent times — offer only what this returns, or you will double-book.',
        parameters: {
          type: 'object',
          properties: {
            days_ahead: { type: 'number', description: 'How many days out to look (default 5)' },
          },
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'book_meeting',
        description:
          'Book a meeting on the shared calendar during the call. Only use a start time that came back from check_availability, and read the time back to them before calling this.',
        parameters: {
          type: 'object',
          properties: {
            start_iso: { type: 'string', description: 'Start time in ISO 8601, exactly as returned by check_availability' },
            title: { type: 'string', description: 'What the meeting is, e.g. "Demo — Sunshine Toyota"' },
          },
          required: ['start_iso'],
        },
      },
    });
  }

  tools.push({
    type: 'function',
    function: {
      name: 'capture_callback',
      description:
        'Record that they asked to be called back at a specific time. Use this whenever anyone — including a gatekeeper — tells you a better time to call, so we actually ring back then.',
      parameters: {
        type: 'object',
        properties: {
          when_iso: { type: 'string', description: 'When to call back, ISO 8601' },
          ask_for: { type: 'string', description: 'Who to ask for, if they named someone' },
          note: { type: 'string', description: 'Anything useful they said about timing or the right person' },
        },
        required: ['when_iso'],
      },
    },
  });

  return tools;
}

export interface CallToolContext {
  organizationId: string;
  leadId?: string;
  /** The number Vapi dialled — the only place a text may go. */
  calledNumber?: string;
  /**
   * Sandbox call: the assistant behaves exactly as it would on a real call, but
   * nothing leaves the building and nothing is written. Reads (real calendar
   * openings) still run, so a script can be tuned against genuine times.
   */
  rehearsal?: boolean;
}

/**
 * Run one mid-call tool. Returns a short string for the assistant to SAY, so it
 * must read naturally out loud and never contain markup or IDs.
 */
export async function executeCallTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CallToolContext
): Promise<string> {
  // check_availability is read-only, so a rehearsal can use the real calendar.
  if (name === 'check_availability') {
    return checkAvailability(Number(args.days_ahead) || 5, ctx);
  }

  const lead = ctx.leadId
    ? await prisma.lead.findFirst({ where: { id: ctx.leadId, organizationId: ctx.organizationId } })
    : null;

  // A rehearsal has no lead to act on and must not send or write. Answer as the
  // real tool would so the conversation plays out normally.
  if (ctx.rehearsal || !lead) {
    if (!ctx.rehearsal) return 'Sorry, I could not look that up just now.';
    switch (name) {
      case 'send_text_link':
        return 'Sent — it should be on your phone now.';
      case 'book_meeting': {
        const start = new Date(String(args.start_iso || ''));
        const spoken = Number.isNaN(start.getTime())
          ? 'that time'
          : start.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
        return `Booked for ${spoken}. Confirm that back to them and say they will get an email invite.`;
      }
      case 'capture_callback':
        return 'Got it — noted. Confirm that back to them before ending the call.';
      default:
        return 'That is not something I can do on this call.';
    }
  }

  switch (name) {
    case 'send_text_link':
      return sendTextLink(String(args.link || 'demo'), lead, ctx);
    case 'book_meeting':
      return bookMeeting(String(args.start_iso || ''), args.title ? String(args.title) : undefined, lead, ctx);
    case 'capture_callback':
      return captureCallback(
        String(args.when_iso || ''),
        args.ask_for ? String(args.ask_for) : undefined,
        args.note ? String(args.note) : undefined,
        lead,
        ctx
      );
    default:
      return 'That is not something I can do on this call.';
  }
}

async function sendTextLink(
  kind: string,
  lead: { id: string; companyName: string; phone: string | null; doNotContact: boolean },
  ctx: CallToolContext
): Promise<string> {
  if (lead.doNotContact) return 'I am not able to send that.';

  const cfg = await getOrgConfig(ctx.organizationId);
  if (!channels.isSmsConfigured(cfg.twilio)) {
    return 'I cannot text right now, but I will email it over instead.';
  }

  // Only ever the number we called, or the one already on the lead.
  const to = ctx.calledNumber || lead.phone;
  if (!to) return 'I do not have a mobile number for you — I will email it instead.';

  const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });

  // Hard stops this path used to skip entirely. The org kill switch and the
  // suppression list are absolute: a paused organization must send nothing, and
  // a number someone has opted out of is not made textable by them being on the
  // phone. Both were unreachable here because this is the one send path that
  // does not go through the Engine's tools. Checked before the link lookups so
  // a refusal costs nothing.
  if (org?.paused) {
    return 'I cannot text that right now, but I will email it over instead.';
  }
  const suppressed = await suppressionReason(ctx.organizationId, { phone: to });
  if (suppressed) {
    return 'I will email that over instead.';
  }

  let url: string | null = null;
  let label = 'the link';
  if (kind === 'booking') {
    const link = await defaultBookingLink(ctx.organizationId);
    url = link ? `${config.appPublicUrl}/book/${link.slug}` : null;
    label = 'a link to grab a time';
  } else {
    url = cfg.demoVideoUrl || null;
    label = 'the demo';
  }
  if (!url) {
    return kind === 'booking'
      ? 'I do not have a booking link set up — I will follow up by email.'
      : 'I do not have that link to hand — I will email it straight after this call.';
  }

  // Quiet hours and the daily cap are DELIBERATELY not enforced here, which is
  // the one part of the old behaviour worth keeping. The prospect is on the
  // phone right now and just asked for this link: they are demonstrably awake,
  // and refusing a message they requested mid-conversation would make the call
  // fall apart. The touch is still recorded below, so the cap stays honest even
  // though it does not block.
  const body = `${org?.name || 'Hi'} — here's ${label} as promised: ${url}`;
  const result = await channels.sendSms({ to, body }, cfg.twilio);

  await leadService.logActivity({
    organizationId: ctx.organizationId,
    leadId: lead.id,
    // Only a delivered text is a touch. Logging SMS_SENT on failure spent the
    // org's daily cap on a message the prospect never received.
    type: result.sent ? 'SMS_SENT' : 'NOTE',
    summary: `${result.sent ? 'Texted' : 'Failed to text'} ${label} to ${to} during the call`,
    payload: { midCall: true, link: kind, url, to, status: result.sent ? 'sent' : 'failed' },
  });
  if (result.sent) {
    await leadService.advanceStatusOnTouch(lead.id, 'SMS');
  }

  return result.sent
    ? 'Sent — it should be on your phone now.'
    : 'That did not go through, so I will email it right after we hang up.';
}

async function checkAvailability(daysAhead: number, ctx: CallToolContext): Promise<string> {
  const link = await defaultBookingLink(ctx.organizationId);
  if (!link) return 'I do not have a calendar to check — I will follow up with times by email.';

  const slots = await computeSlots(link, Math.min(Math.max(daysAhead, 1), 14)).catch(() => []);
  if (!slots.length) return 'I do not see anything open in the next few days — I will email you some options.';

  // Three options, spoken conversationally. More than that is unusable by ear.
  const spoken = slots.slice(0, 3).map((s) => {
    const d = new Date(s.startIso);
    return d.toLocaleString('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: link.timezone || 'America/New_York',
    });
  });
  const iso = slots.slice(0, 3).map((s) => s.startIso);
  return `Open times: ${spoken.join(', ')}. Offer these out loud and, once they pick one, call book_meeting with the matching start time from this list: ${iso.join(' | ')}`;
}

async function bookMeeting(
  startIso: string,
  title: string | undefined,
  lead: { id: string; companyName: string },
  ctx: CallToolContext
): Promise<string> {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now()) {
    return 'I could not lock that time in — let me follow up by email to confirm.';
  }
  const link = await defaultBookingLink(ctx.organizationId);
  const end = new Date(start.getTime() + (link?.durationMinutes || 30) * 60_000);

  // Refuse to double-book: an overlapping event means our side is already busy.
  const clash = await prisma.calendarEvent.findFirst({
    where: {
      organizationId: ctx.organizationId,
      status: { not: 'CANCELLED' },
      startAt: { lt: end },
      endAt: { gt: start },
    },
    select: { id: true },
  });
  if (clash) return 'That one just got taken — could you pick another of those times?';

  const eventTitle = title || `${link?.title || 'Demo'} — ${lead.companyName}`;
  const event = await prisma.calendarEvent.create({
    data: {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      title: eventTitle,
      startAt: start,
      endAt: end,
      type: 'MEETING',
      status: 'SCHEDULED',
      description: 'Booked by the AI while on a phone call with the lead.',
      ...(link ? { bookingLinkId: link.id } : {}),
    },
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'INTERESTED' } });
  await leadService.logActivity({
    organizationId: ctx.organizationId,
    leadId: lead.id,
    type: 'NOTE',
    summary: `Meeting booked during a call for ${start.toISOString()}`,
    payload: { midCall: true, calendarEventId: event.id, startAt: start.toISOString() },
  });

  // A meeting on the calendar that nobody was told about is a missed meeting.
  await notify({
    organizationId: ctx.organizationId,
    type: 'MEETING_BOOKED',
    title: `Meeting booked on a call: ${lead.companyName}`,
    body: `The AI booked "${eventTitle}" for ${start.toUTCString()} during a phone call.`,
    leadId: lead.id,
    emailAlert: true,
  }).catch(() => undefined);

  const invited = await sendInvite(event.id, eventTitle, start, end, lead, ctx.organizationId);

  const spoken = start.toLocaleString('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: link?.timezone || 'America/New_York',
  });
  return invited
    ? `Booked for ${spoken}. Confirm that back to them and say the calendar invite is on its way by email.`
    : `Booked for ${spoken}. Confirm that back to them, and ask for the best email so we can send the invite.`;
}

/**
 * Email the calendar invite to whoever we have an address for. Returns false when
 * we can't, so the assistant asks for an email instead of promising one is coming.
 */
async function sendInvite(
  eventId: string,
  title: string,
  start: Date,
  end: Date,
  lead: { id: string; companyName: string },
  organizationId: string
): Promise<boolean> {
  const contact = await prisma.contact.findFirst({
    where: { leadId: lead.id, email: { not: null }, optedOut: false },
    orderBy: { isPrimary: 'desc' },
  });
  const to = contact?.email;
  if (!to) return false;

  // Resolved through the sending infrastructure rather than the raw Mailgun
  // creds: an org running entirely out of a connected inbox has no Mailgun to
  // read, and the caller's confirmation email went silently unsent.
  const sender = await resolveSender(organizationId, { purpose: 'TRANSACTIONAL' });
  if (!sender) return false;

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const ics = buildIcs({
    uid: `${eventId}@social-engine`,
    title,
    start,
    end,
    organizerName: org?.name,
    organizerEmail: sender.fromEmail,
    attendeeEmail: to,
    attendeeName: contact?.firstName ? `${contact.firstName} ${contact.lastName || ''}`.trim() : undefined,
  });
  const result = await deliverEmail(sender, {
    to,
    subject: `Confirmed: ${title}`,
    body: `Hi${contact?.firstName ? ` ${contact.firstName}` : ''},\n\nGreat speaking with you — confirming ${start.toUTCString()}.\n\nThe calendar invite is attached.\n\nSpeak soon!`,
    fromName: org?.name,
    fromEmail: sender.fromEmail,
    ics: { filename: 'invite.ics', content: ics },
  }).catch(() => ({ sent: false }));
  if (result.sent) await markEmailSent(sender).catch(() => undefined);
  return !!result.sent;
}

async function captureCallback(
  whenIso: string,
  askFor: string | undefined,
  note: string | undefined,
  lead: { id: string; companyName: string },
  ctx: CallToolContext
): Promise<string> {
  const when = new Date(whenIso);
  if (Number.isNaN(when.getTime())) {
    return 'Noted — I will make sure someone follows up.';
  }
  // Never schedule into the past; if they said a time that has passed, use +1h.
  const runAt = when.getTime() > Date.now() ? when : new Date(Date.now() + 3600_000);

  await prisma.agentJob.create({
    data: {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'FOLLOW_UP',
      role: 'CALLER',
      objective: `Callback requested during a previous call${askFor ? ` — ask for ${askFor}` : ''}. ${note ? `They said: "${note.slice(0, 300)}". ` : ''}Call ${lead.companyName} back now as agreed, and open by referencing that they asked us to call at this time.`,
      runAt,
    },
  });
  await leadService.logActivity({
    organizationId: ctx.organizationId,
    leadId: lead.id,
    type: 'NOTE',
    summary: `Callback scheduled for ${runAt.toISOString()}${askFor ? ` (ask for ${askFor})` : ''}`,
    payload: { midCall: true, askFor, note },
  });

  const spoken = runAt.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return `Got it — noted for ${spoken}. Confirm that back to them before ending the call.`;
}
