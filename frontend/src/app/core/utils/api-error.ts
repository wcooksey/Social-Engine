/**
 * Pull the server's message out of an HttpErrorResponse.
 *
 * The API's error envelope is `{ success: false, error: "some message" }` — a
 * string, not an object. Reading `err.error.error.message` therefore yields
 * undefined and the caller falls back to a generic toast, hiding the one thing
 * the user needs ("Anthropic is not configured — add its API key in Settings").
 * This accepts both shapes so a message is never swallowed.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const body = (err as { error?: unknown })?.error;
  if (typeof body === 'string' && body.trim()) return body;

  const inner = (body as { error?: unknown; message?: unknown })?.error;
  if (typeof inner === 'string' && inner.trim()) return inner;
  if (typeof (inner as { message?: unknown })?.message === 'string') {
    return (inner as { message: string }).message;
  }

  const message = (body as { message?: unknown })?.message;
  if (typeof message === 'string' && message.trim()) return message;

  return fallback;
}
