import crypto from 'crypto';
import { config } from '../config/environment';

/**
 * Stateless signed tokens for public links (unsubscribe, one-click actions).
 * Payload is a plain string (e.g. a contactId) with an HMAC tag, so the public
 * endpoint can trust it without a login or a database-stored nonce.
 */

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload: string): string {
  return b64url(crypto.createHmac('sha256', config.jwt.secret).update(payload).digest());
}

/** Produce a `<payload>.<sig>` token safe to embed in a URL. */
export function signToken(payload: string): string {
  return `${b64url(Buffer.from(payload))}.${sign(payload)}`;
}

/** Verify a token and return its payload, or null if tampered/invalid. */
export function verifyToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadPart = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = fromB64url(payloadPart).toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return payload;
}
