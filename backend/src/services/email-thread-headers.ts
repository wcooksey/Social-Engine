/** Mailgun supplies headers both as form fields and as a JSON array of pairs. */
export function emailThreadHeaders(body: Record<string, unknown>) {
  const headers = new Map<string, string>();
  let pairs = body['message-headers'];
  if (typeof pairs === 'string') {
    try { pairs = JSON.parse(pairs); } catch { pairs = []; }
  }
  if (Array.isArray(pairs)) for (const pair of pairs) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      headers.set(pair[0].toLowerCase(), pair[1]);
    }
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') headers.set(key.toLowerCase(), value);
  }
  return {
    externalId: headers.get('message-id'),
    inReplyTo: headers.get('in-reply-to'),
    references: headers.get('references'),
  };
}

/** Prefer the immediate parent, then walk References from newest to oldest. */
export function replyMessageIds(inReplyTo?: string, references?: string): string[] {
  const parse = (value = '') => (value.match(/<[^<>\s]+>|[^\s<>]+/g) || [])
    .map(id => id.replace(/^<|>$/g, '')).filter(id => id.includes('@'));
  return [...new Set([...parse(inReplyTo), ...parse(references).reverse()])].slice(0, 50);
}
