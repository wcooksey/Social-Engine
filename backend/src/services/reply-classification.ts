const AUTO_REPLY_RE = new RegExp(
  [
    'out\\s+of\\s+(the\\s+)?office',
    'auto(matic)?[- ]?repl(y|ies)',
    'automatic response',
    'away from (my|the) (desk|office)',
    'on (annual |parental |sick )?leave until',
    'currently (away|unavailable|on holiday|on vacation)',
    'thank you for (your )?(email|message)[^.]{0,40}(will respond|will get back|has been received)',
    'this (is|was) an automated',
    'do[- ]not[- ]reply',
    'undeliverable',
    'delivery status notification',
    'mail delivery (failed|subsystem)',
    'ticket #?\\d+ (has been )?(created|opened)',
  ].join('|'),
  'i'
);

/** True when this looks machine-generated rather than written by a person. */
export function looksAutomated(subject: string | undefined, body: string): boolean {
  const head = `${subject || ''}\n${body.slice(0, 600)}`;
  return AUTO_REPLY_RE.test(head);
}

export function isHumanReply(message: { direction: string; subject?: string | null; body: string; provenance?: unknown }, threadSubject?: string | null): boolean {
  if (message.direction !== 'INBOUND') return false;
  const provenance = message.provenance as { replyKind?: string } | null;
  if (provenance?.replyKind === 'automated') return false;
  if (provenance?.replyKind === 'human') return true;
  // Older messages predate classification; use the same conservative detector.
  return !looksAutomated(message.subject ?? threadSubject ?? undefined, message.body);
}
