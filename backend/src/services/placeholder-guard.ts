/**
 * Refuse to send a message that still has its template tokens in it.
 *
 * Playbooks are written in prose, and prose written for a human reads naturally
 * with fill-in slots: "Hey [first], quick question about [dealership name]".
 * The model is expected to substitute those from the lead record. When it does
 * not — because the lead has no contact name, because the token names something
 * the platform never knew (`[Your Name]`, resolved at SEND time, after the body
 * is written), or simply because it copied the playbook verbatim — the literal
 * bracket goes out to a prospect.
 *
 * Nothing anywhere caught that. This is the last line of defence, applied at
 * every point a body becomes a real message.
 */

/**
 * A bracketed run short enough to be a fill-in slot rather than prose.
 *
 * Single-line and length-capped on purpose: a long bracketed passage is far
 * more likely to be a quoted aside than a merge field, and refusing it would
 * turn a safety net into an obstacle.
 */
const TOKEN = /\[([^\]\n]{1,40})\]/g;

/**
 * Bracket contents that are legitimately part of a message body.
 *
 * Footnote markers and reference numbers are the realistic case; a lone digit
 * in brackets is never a merge field.
 */
function isLegitimate(inner: string): boolean {
  const t = inner.trim();
  if (!t) return false;
  if (/^\d{1,3}$/.test(t)) return true; // [1], [2] — footnote markers
  return false;
}

/** Every unresolved token in `text`, deduplicated, in order of appearance. */
export function findUnresolvedPlaceholders(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    if (isLegitimate(match[1])) continue;
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

/**
 * A refusal message aimed at whoever can actually fix it.
 *
 * The agent gets told what to do instead of being told off, because it is the
 * one that must retry: naming the tokens and the remedy turns a dead end into a
 * correction it can make on the next tool call.
 */
export function placeholderRefusal(tokens: string[], channel: 'email' | 'SMS' | 'DM' | 'form'): string {
  const list = tokens.join(', ');
  const plural = tokens.length === 1 ? 'a template placeholder' : 'template placeholders';
  return (
    `This ${channel} still contains ${plural}: ${list}. Not sent — a literal bracket reaching a ` +
    'prospect is worse than a late reply. Rewrite the message with real values: use the lead and ' +
    'contact record for names and company details, and get_booking_links for a booking URL. Do NOT ' +
    "write the sender's own name or a sign-off — the platform stamps the correct sender on the " +
    'message after you write it, so anything you invent there will contradict the From header.'
  );
}

/**
 * Throw-free check for the send paths: returns a refusal reason, or null.
 *
 * Callers return `{ sent: false, reason }` so the agent sees a normal blocked
 * result and can correct itself, rather than an exception it cannot act on.
 */
export function placeholderBlockReason(
  text: string,
  channel: 'email' | 'SMS' | 'DM' | 'form'
): string | null {
  const tokens = findUnresolvedPlaceholders(text);
  return tokens.length ? placeholderRefusal(tokens, channel) : null;
}

/**
 * The tokens that are unambiguously merge fields rather than prose.
 *
 * Used on the human-approval path, where someone may legitimately quote or
 * annotate with brackets. Refusing "[see attached]" in a reply an operator
 * wrote and read would be the guard getting in the way of the person it is
 * supposed to help, so only the known slots block there.
 */
const KNOWN_TOKENS = new Set([
  'first',
  'first name',
  'firstname',
  'name',
  'your name',
  'company',
  'company name',
  'dealership',
  'dealership name',
  'booking link',
  'link',
  'city',
  'title',
  'lead',
]);

/** Known merge tokens only — for bodies a human has actually read. */
export function findKnownPlaceholders(text: string): string[] {
  return findUnresolvedPlaceholders(text).filter((token) =>
    KNOWN_TOKENS.has(token.slice(1, -1).trim().toLowerCase())
  );
}
