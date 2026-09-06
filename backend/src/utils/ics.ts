/**
 * Minimal iCalendar (.ics) builder for meeting invites. An emailed .ics with
 * METHOD:REQUEST renders as a native "add to calendar" invite in Gmail /
 * Outlook / Apple Mail, so leads land the meeting on their real calendar
 * without any OAuth integration on our side.
 */

export interface IcsEvent {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  organizerName?: string;
  organizerEmail?: string;
  attendeeEmail?: string;
  attendeeName?: string;
  /** DTSTAMP / sequence anchor. Defaults to start. */
  createdAt?: Date;
  method?: 'REQUEST' | 'CANCEL';
  sequence?: number;
}

function fmt(date: Date): string {
  // UTC basic format: 20260709T170000Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold lines to 75 octets per RFC 5545 (simple char-based fold is fine here).
function fold(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let s = line;
  parts.push(s.slice(0, 74));
  s = s.slice(74);
  while (s.length > 73) {
    parts.push(' ' + s.slice(0, 73));
    s = s.slice(73);
  }
  if (s.length) parts.push(' ' + s);
  return parts.join('\r\n');
}

export function buildIcs(ev: IcsEvent): string {
  const method = ev.method || 'REQUEST';
  const stamp = ev.createdAt || ev.start;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Neuralnetics//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${fmt(stamp)}`,
    `DTSTART:${fmt(ev.start)}`,
    `DTEND:${fmt(ev.end)}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    `SUMMARY:${escapeText(ev.title)}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.organizerEmail) {
    const cn = ev.organizerName ? `;CN=${escapeText(ev.organizerName)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${ev.organizerEmail}`);
  }
  if (ev.attendeeEmail) {
    const cn = ev.attendeeName ? `;CN=${escapeText(ev.attendeeName)}` : '';
    lines.push(
      `ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ev.attendeeEmail}`
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
