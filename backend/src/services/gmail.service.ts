import crypto from 'crypto';
import type { GmailAccount } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { decrypt, encrypt, isEncryptionConfigured } from '../utils/encryption';
import { signToken, verifyToken } from '../utils/signing';
import { resolveOrg } from './settings.service';
import type { IcsAttachment, SendResult } from './channels.service';

/**
 * Gmail as a sending and receiving channel.
 *
 * Mailgun domains are volume infrastructure — bought to be burned, warmed on a
 * ramp, rotated through a pool. An inbox is the opposite: one address, low
 * volume, mail that leaves as a person rather than as a system, and replies
 * that land where their owner already reads mail. Both are legitimate ways to
 * run outreach and they suit different work, so a playbook picks one.
 *
 * Everything here talks to Google over plain HTTPS rather than through the
 * googleapis SDK: the surface used is four endpoints wide, and the SDK would
 * add a large dependency to a backend that deliberately calls Mailgun, Twilio
 * and Vapi with `fetch`.
 *
 * The refresh token IS the account. It is encrypted at rest with the same key
 * as social login sessions, never returned by the API, and never logged.
 */

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Scope requested at consent.
 *
 * `gmail.modify` covers everything this integration does — read the inbox for
 * replies, send, and change labels — while still refusing permanent deletion,
 * so a bug here cannot destroy someone's mail. It is a RESTRICTED scope: an app
 * offering this to the public needs Google's verification review, though an
 * owner connecting their own inbox to their own deployment can stay in Testing
 * mode indefinitely. See docs/GMAIL_SETUP.md.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/** How long a connect link stays valid. Long enough to log into Google. */
const STATE_TTL_MS = 15 * 60 * 1000;

/** Refresh an access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60 * 1000;

/** Ceiling on any single Google call, so a hung request can't stall a sweep. */
const HTTP_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  configured: boolean;
}

/**
 * Where Google sends the browser back to. Registered by hand in the Google
 * Cloud console, so it is derived from one value rather than configured twice:
 * a mismatch here is the single most common reason a connect attempt fails.
 */
export function gmailRedirectUri(): string {
  return `${config.appPublicUrl}/api/public/gmail/callback`;
}

export async function googleOAuthConfig(organizationId: string): Promise<GoogleOAuthConfig> {
  const [clientId, clientSecret] = await Promise.all([
    resolveOrg(organizationId, 'GOOGLE_OAUTH_CLIENT_ID'),
    resolveOrg(organizationId, 'GOOGLE_OAUTH_CLIENT_SECRET'),
  ]);
  return {
    clientId,
    clientSecret,
    redirectUri: gmailRedirectUri(),
    configured: !!(clientId && clientSecret),
  };
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/**
 * The `state` parameter, which is how the callback knows whose inbox this is.
 *
 * Google's redirect arrives with no session — it is a browser hop, not an API
 * call — so the tenant has to travel in the request itself. It is HMAC-signed
 * with the deployment's JWT secret and time-boxed, so a fabricated state cannot
 * attach someone's inbox to another organization, and a stale link cannot be
 * replayed weeks later.
 */
function encodeState(organizationId: string, userId: string): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  return signToken(`gmail:${organizationId}:${userId}:${Date.now()}:${nonce}`);
}

export function decodeState(
  state: unknown
): { organizationId: string; userId: string } | null {
  if (typeof state !== 'string' || !state) return null;
  const payload = verifyToken(state);
  if (!payload) return null;
  const [kind, organizationId, userId, issuedAt] = payload.split(':');
  if (kind !== 'gmail' || !organizationId || !userId) return null;
  const age = Date.now() - Number(issuedAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return null;
  return { organizationId, userId };
}

/**
 * The Google consent URL to send an operator to.
 *
 * `access_type=offline` with `prompt=consent` is what produces a refresh token.
 * Google only issues one on the FIRST consent for a client/user pair, so
 * reconnecting an account that was already connected would otherwise come back
 * with an access token that expires in an hour and no way to renew it —
 * forcing the consent screen every time is what makes reconnecting work.
 */
export async function buildGmailAuthUrl(
  organizationId: string,
  userId: string
): Promise<string> {
  const oauth = await googleOAuthConfig(organizationId);
  if (!oauth.configured) {
    throw new Error(
      'Google OAuth is not configured — add a client ID and secret under Settings → Integrations first.'
    );
  }
  if (!isEncryptionConfigured()) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set — refusing to connect an inbox we could only store in plaintext.'
    );
  }
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: encodeState(organizationId, userId),
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new Error(
      `Google OAuth ${res.status}: ${json.error_description || json.error || 'token request failed'}`
    );
  }
  return json;
}

/**
 * Finish the connect: swap the one-time code for tokens, ask Gmail which
 * address it just handed us, and store it.
 *
 * The address comes from `users/me/profile` rather than from an extra
 * `userinfo.email` scope — one fewer permission on the consent screen for the
 * same answer, and it is the address Gmail will actually send as, which a
 * profile email is not guaranteed to be.
 *
 * Reconnecting an existing address updates it in place instead of creating a
 * second row: playbooks point at the account id, and a fresh row would silently
 * unhook every playbook that was sending through it.
 */
export async function completeGmailConnection(
  organizationId: string,
  userId: string,
  code: string
): Promise<GmailAccount> {
  const oauth = await googleOAuthConfig(organizationId);
  if (!oauth.configured) throw new Error('Google OAuth is not configured for this organization.');

  const token = await postToken({
    code,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    redirect_uri: oauth.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!token.access_token) throw new Error('Google returned no access token.');

  const granted = (token.scope || '').split(/\s+/).filter(Boolean);
  const missing = GMAIL_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw new Error(
      `Google did not grant the permissions this needs (${missing.join(', ')}). ` +
        'Reconnect and leave every box on the consent screen ticked.'
    );
  }

  const profile = await gmailApi<{ emailAddress?: string; historyId?: string }>(
    token.access_token,
    '/profile'
  );
  const address = profile.emailAddress?.trim().toLowerCase();
  if (!address) throw new Error('Google did not report which address was connected.');

  const existing = await prisma.gmailAccount.findUnique({ where: { emailAddress: address } });
  if (existing && existing.organizationId !== organizationId) {
    throw new Error(
      `${address} is already connected to another organization on this deployment.`
    );
  }

  // Only overwrite the refresh token when Google actually issued a new one:
  // a re-consent that returns none would otherwise wipe the only durable
  // credential the account has.
  const refresh = token.refresh_token
    ? encrypt(token.refresh_token)
    : existing?.refreshTokenEncrypted;
  if (!refresh) {
    throw new Error(
      'Google issued no refresh token. Remove this app at myaccount.google.com/permissions and connect again.'
    );
  }

  const shared = {
    organizationId,
    emailAddress: address,
    status: 'CONNECTED' as const,
    refreshTokenEncrypted: refresh,
    accessTokenEncrypted: encrypt(token.access_token),
    accessTokenExpiresAt: expiryFrom(token.expires_in),
    grantedScopes: granted.join(' '),
    lastError: null,
    connectedByUserId: userId,
    // Start the reply sweep from here rather than from the beginning of time:
    // ingesting a decade of a real person's inbox is not what connecting an
    // account is asking for.
    lastHistoryId: profile.historyId ?? null,
    lastSyncAt: new Date(),
  };

  return existing
    ? prisma.gmailAccount.update({ where: { id: existing.id }, data: shared })
    : prisma.gmailAccount.create({ data: shared });
}

function expiryFrom(expiresIn: number | undefined): Date | null {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

/**
 * Disconnect: tell Google to forget the grant, then drop the row.
 *
 * Revocation is best-effort — a token Google has already invalidated returns an
 * error, and refusing to disconnect because of that would strand the account in
 * the UI with no way to remove it.
 */
export async function disconnectGmailAccount(account: GmailAccount): Promise<void> {
  const refresh = safeDecrypt(account.refreshTokenEncrypted);
  if (refresh) {
    await fetch(`${OAUTH_REVOKE_URL}?token=${encodeURIComponent(refresh)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => undefined);
  }
  await prisma.gmailAccount.delete({ where: { id: account.id } });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function safeDecrypt(payload: string | null): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/** Raised when Google says the grant is gone. The account needs reconnecting. */
export class GmailAuthError extends Error {}

/**
 * A usable access token for this account, refreshing when the cached one is
 * spent.
 *
 * An `invalid_grant` here is terminal rather than transient — the user revoked
 * access, changed their password, or the consent lapsed — so the account is
 * marked EXPIRED immediately. Retrying it every sweep would just burn quota and
 * leave the operator wondering why nothing sends.
 */
export async function gmailAccessToken(account: GmailAccount): Promise<string> {
  const cached = safeDecrypt(account.accessTokenEncrypted);
  const expiresAt = account.accessTokenExpiresAt?.getTime() ?? 0;
  if (cached && expiresAt - TOKEN_SKEW_MS > Date.now()) return cached;

  const refresh = safeDecrypt(account.refreshTokenEncrypted);
  if (!refresh) {
    await markAccountBroken(account.id, 'EXPIRED', 'Stored credentials could not be read.');
    throw new GmailAuthError(
      `${account.emailAddress}: stored credentials could not be decrypted — reconnect the inbox.`
    );
  }

  const oauth = await googleOAuthConfig(account.organizationId);
  if (!oauth.configured) {
    throw new GmailAuthError(
      'Google OAuth is not configured — add a client ID and secret under Settings → Integrations.'
    );
  }

  let token: TokenResponse;
  try {
    token = await postToken({
      refresh_token: refresh,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'token refresh failed';
    if (/invalid_grant|unauthorized_client|invalid_client/i.test(message)) {
      await markAccountBroken(account.id, 'EXPIRED', message);
      throw new GmailAuthError(
        `${account.emailAddress}: Google has revoked this connection — reconnect the inbox under Settings → Sending.`
      );
    }
    await markAccountBroken(account.id, 'ERROR', message);
    throw new Error(message);
  }

  if (!token.access_token) {
    await markAccountBroken(account.id, 'ERROR', 'Google returned no access token.');
    throw new Error(`${account.emailAddress}: Google returned no access token.`);
  }

  await prisma.gmailAccount
    .update({
      where: { id: account.id },
      data: {
        accessTokenEncrypted: encrypt(token.access_token),
        accessTokenExpiresAt: expiryFrom(token.expires_in),
        ...(account.status === 'ERROR' || account.status === 'EXPIRED'
          ? { status: 'CONNECTED' as const, lastError: null }
          : {}),
      },
    })
    .catch(() => undefined);
  return token.access_token;
}

async function markAccountBroken(
  id: string,
  status: 'EXPIRED' | 'ERROR',
  detail: string
): Promise<void> {
  await prisma.gmailAccount
    .update({ where: { id }, data: { status, lastError: detail.slice(0, 400) } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// API plumbing
// ---------------------------------------------------------------------------

async function gmailApi<T>(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Gmail ${res.status}: ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** Authenticated Gmail call for an account, refreshing its token as needed. */
export async function callGmail<T>(
  account: GmailAccount,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await gmailAccessToken(account);
  return gmailApi<T>(token, path, init);
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

/** RFC 2047 encoding, applied only when a header actually needs it. */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** `"Display Name" <addr@x>`, with the name quoted and escaped. */
export function gmailFromHeader(address: string, displayName?: string | null): string {
  const name = displayName?.replace(/[\r\n]+/g, ' ').trim();
  if (!name) return address;
  const encoded = encodeHeader(name);
  // An encoded word must not be quoted; a plain name must be, so a comma or an
  // angle bracket in a business name cannot produce a header Gmail rejects.
  return encoded.startsWith('=?')
    ? `${encoded} <${address}>`
    : `"${encoded.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

export interface GmailMimeOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  html?: string;
  unsubscribeUrl?: string;
  ics?: IcsAttachment;
  /** Message-ID of the message being answered, for real client-side threading. */
  inReplyTo?: string;
  /** Accumulated References chain, oldest first. */
  references?: string[];
}

function base64Lines(input: Buffer | string): string {
  const b64 = (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64');
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * Build the RFC 5322 message Gmail sends verbatim.
 *
 * Text is always present and always first: these messages are written to read
 * like a personal note, and a text/plain part is what a person's mail client
 * shows when it has the choice.
 */
export function buildGmailMime(opts: GmailMimeOptions): string {
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references?.length) headers.push(`References: ${opts.references.join(' ')}`);
  if (opts.unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${opts.unsubscribeUrl}>`);
    if (!opts.unsubscribeUrl.startsWith('mailto:')) {
      headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    }
  }

  const boundary = () => `==_se_${crypto.randomBytes(12).toString('hex')}`;

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(opts.body),
  ].join('\r\n');

  let content: string;
  let contentType: string;

  if (opts.html) {
    const alt = boundary();
    contentType = `multipart/alternative; boundary="${alt}"`;
    content = [
      `--${alt}`,
      textPart,
      `--${alt}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(opts.html),
      `--${alt}--`,
    ].join('\r\n');
  } else {
    contentType = 'text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';
    content = base64Lines(opts.body);
  }

  if (opts.ics) {
    const mixed = boundary();
    const inner = opts.html
      ? [`Content-Type: ${contentType}`, '', content].join('\r\n')
      : textPart;
    const body = [
      `--${mixed}`,
      inner,
      `--${mixed}`,
      `Content-Type: text/calendar; charset="UTF-8"; method=REQUEST; name="${opts.ics.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${opts.ics.filename}"`,
      '',
      base64Lines(opts.ics.content),
      `--${mixed}--`,
    ].join('\r\n');
    return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', body].join('\r\n');
  }

  return [...headers, `Content-Type: ${contentType}`, '', content].join('\r\n');
}

function base64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface GmailSendOptions extends Omit<GmailMimeOptions, 'from'> {
  /** Display name for the From header; the address is the account's own. */
  fromName?: string;
  /** Gmail thread to send inside, so the reply is not a new conversation. */
  threadId?: string;
}

export interface GmailSendResult extends SendResult {
  /** Gmail's own id for the thread, to keep the next reply inside it. */
  threadId?: string;
  /** The real RFC 5322 Message-ID, which is what threads the NEXT reply. */
  headerMessageId?: string;
}

/**
 * Put a message on the wire as this inbox.
 *
 * Gmail replaces any Message-ID we supply with one of its own, so the header is
 * read back after the send rather than assumed. That read is best-effort: a
 * delivered message must never be reported as failed because a follow-up
 * metadata call timed out — the cost of losing it is one thread that starts
 * fresh, not a duplicate send.
 */
export async function sendViaGmail(
  account: GmailAccount,
  opts: GmailSendOptions
): Promise<GmailSendResult> {
  const raw = buildGmailMime({
    ...opts,
    from: gmailFromHeader(account.emailAddress, opts.fromName ?? account.displayName),
  });

  try {
    const sent = await callGmail<{ id?: string; threadId?: string }>(account, '/messages/send', {
      method: 'POST',
      body: { raw: base64Url(raw), ...(opts.threadId ? { threadId: opts.threadId } : {}) },
    });

    let headerMessageId: string | undefined;
    if (sent.id) {
      const meta = await callGmail<{ payload?: { headers?: { name: string; value: string }[] } }>(
        account,
        `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`
      ).catch(() => null);
      headerMessageId = meta?.payload?.headers?.find(
        (h) => h.name.toLowerCase() === 'message-id'
      )?.value;
    }

    return {
      sent: true,
      externalId: sent.id,
      threadId: sent.threadId,
      headerMessageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gmail send failed';
    // A 4xx that is not an auth problem is usually the message itself (a bad
    // address, an oversized attachment); a 429/5xx is Google, not us. Either
    // way the caller decides whether to retry — this only records what broke.
    if (!(err instanceof GmailAuthError)) {
      await prisma.gmailAccount
        .update({ where: { id: account.id }, data: { lastError: message.slice(0, 400) } })
        .catch(() => undefined);
    }
    return { sent: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Daily volume
// ---------------------------------------------------------------------------

/** UTC midnight — the day boundary the send counter is bucketed by. */
function utcDay(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Sends already made today, treating a stale counter as zero. */
export function gmailSentToday(account: GmailAccount, now: Date = new Date()): number {
  if (!account.sentDate) return 0;
  return account.sentDate.getTime() === utcDay(now).getTime() ? account.sentCount : 0;
}

/** When this inbox may next send, given its own spacing. */
export function gmailNextSendAt(account: GmailAccount, now: Date = new Date()): Date {
  if (!account.lastSendAt) return now;
  const ready = new Date(account.lastSendAt.getTime() + account.minSpacingSeconds * 1000);
  return ready > now ? ready : now;
}

/**
 * Claim one send against today's cap.
 *
 * A single conditional UPDATE, which Postgres serialises: the day-rollover, the
 * `sentCount < cap` guard and the increment cannot be split by a second agent
 * resolving the same sender at the same instant. The rollover is a separate
 * statement on purpose — it must not be conditional on the cap, or an inbox
 * that spent yesterday's allowance would stay locked out today.
 *
 * Returns false when the cap is spent; the caller must not send.
 */
export async function reserveGmailSend(
  accountId: string,
  cap: number,
  at: Date = new Date()
): Promise<boolean> {
  const today = utcDay(at);
  await prisma.gmailAccount
    .updateMany({
      where: { id: accountId, OR: [{ sentDate: null }, { sentDate: { lt: today } }] },
      data: { sentDate: today, sentCount: 0 },
    })
    .catch(() => undefined);

  const claimed = await prisma.gmailAccount.updateMany({
    where: { id: accountId, sentDate: today, sentCount: { lt: cap } },
    data: { sentCount: { increment: 1 } },
  });
  return claimed.count === 1;
}

/** Hand a claimed slot back when the send did not happen. */
export async function releaseGmailSend(
  accountId: string,
  at: Date = new Date()
): Promise<void> {
  await prisma.gmailAccount
    .updateMany({
      where: { id: accountId, sentDate: utcDay(at), sentCount: { gt: 0 } },
      data: { sentCount: { decrement: 1 } },
    })
    .catch(() => undefined);
}

/**
 * Record that this inbox just sent, for pacing and for the UI.
 *
 * `countSend` is for the paths that never reserved a slot — transactional mail,
 * which no cap gates. The send still happened and still counts toward what
 * Google is willing to accept tomorrow, so the day's total stays honest.
 */
export async function markGmailSent(
  accountId: string,
  at: Date = new Date(),
  countSend = false
): Promise<void> {
  if (countSend) {
    const today = utcDay(at);
    await prisma.gmailAccount
      .updateMany({
        where: { id: accountId, OR: [{ sentDate: null }, { sentDate: { lt: today } }] },
        data: { sentDate: today, sentCount: 0 },
      })
      .catch(() => undefined);
    await prisma.gmailAccount
      .updateMany({ where: { id: accountId, sentDate: today }, data: { sentCount: { increment: 1 } } })
      .catch(() => undefined);
  }
  await prisma.gmailAccount
    .update({ where: { id: accountId }, data: { lastSendAt: at, lastError: null } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Selection & reporting
// ---------------------------------------------------------------------------

/** True when this inbox may be handed out right now. */
export function isGmailAccountUsable(account: GmailAccount): boolean {
  return account.status === 'CONNECTED';
}

/**
 * The inbox a playbook sends through.
 *
 * A playbook that names one gets it. A playbook that names none gets the org's
 * single connected account — and nothing at all when there are several, because
 * whose name goes on a cold email is not a decision to make by picking the
 * first row.
 */
export async function accountForPlaybook(
  organizationId: string,
  gmailAccountId: string | null
): Promise<{ account?: GmailAccount; reason?: string }> {
  if (gmailAccountId) {
    const named = await prisma.gmailAccount.findFirst({
      where: { id: gmailAccountId, organizationId },
    });
    if (!named) {
      return { reason: 'This playbook sends through a Gmail inbox that is no longer connected.' };
    }
    return { account: named };
  }

  const connected = await prisma.gmailAccount.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
  });
  if (connected.length === 0) {
    return {
      reason:
        'This playbook sends through Gmail, but no inbox is connected — connect one under Settings → Sending.',
    };
  }
  if (connected.length > 1) {
    return {
      reason:
        `This playbook sends through Gmail but does not say which of the ${connected.length} connected ` +
        'inboxes — pick one on the playbook.',
    };
  }
  return { account: connected[0] };
}

/** Any usable inbox for this org — the fallback for transactional mail. */
export async function anyUsableGmailAccount(
  organizationId: string
): Promise<GmailAccount | null> {
  return prisma.gmailAccount.findFirst({
    where: { organizationId, status: 'CONNECTED' },
    orderBy: { createdAt: 'asc' },
  });
}

export interface GmailAccountView {
  id: string;
  emailAddress: string;
  displayName: string | null;
  status: GmailAccount['status'];
  dailySendCap: number;
  sentToday: number;
  remainingToday: number;
  minSpacingSeconds: number;
  nextSendAt: string;
  lastSendAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** Playbooks currently routed through this inbox. */
  playbookCount: number;
}

/** Connected inboxes for the API. Tokens never appear here, by construction. */
export async function listGmailAccounts(organizationId: string): Promise<GmailAccountView[]> {
  const now = new Date();
  const accounts = await prisma.gmailAccount.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { playbooks: true } } },
  });
  return accounts.map((account) => {
    const sentToday = gmailSentToday(account, now);
    return {
      id: account.id,
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      status: account.status,
      dailySendCap: account.dailySendCap,
      sentToday,
      remainingToday: Math.max(0, account.dailySendCap - sentToday),
      minSpacingSeconds: account.minSpacingSeconds,
      nextSendAt: gmailNextSendAt(account, now).toISOString(),
      lastSendAt: account.lastSendAt?.toISOString() ?? null,
      lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
      lastError: account.lastError,
      createdAt: account.createdAt.toISOString(),
      playbookCount: account._count.playbooks,
    };
  });
}

/** Addresses this org can send as through a connected inbox. */
export async function connectedGmailAddresses(organizationId: string): Promise<Set<string>> {
  const accounts = await prisma.gmailAccount.findMany({
    where: { organizationId },
    select: { emailAddress: true },
  });
  return new Set(accounts.map((a) => a.emailAddress.toLowerCase()));
}
