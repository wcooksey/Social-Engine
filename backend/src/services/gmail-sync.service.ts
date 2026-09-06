import type { GmailAccount } from '@prisma/client';
import { prisma } from '../config/database';
import { GmailAuthError, callGmail } from './gmail.service';
import { handleInbound } from './inbound.service';

/**
 * Reading replies out of a connected inbox.
 *
 * Mailgun tells us about a reply the moment it lands, because we own the domain
 * and can point an MX record at a webhook. Gmail offers no such thing short of
 * a Pub/Sub topic and a Google Cloud project per deployment, so replies are
 * polled: every worker sweep, each connected inbox is asked what arrived since
 * the last look and anything from a known lead is threaded onto its
 * conversation exactly as a Mailgun reply would be.
 *
 * The read is incremental. Gmail's history API answers "what changed since
 * `historyId`" in one call, which is cheap enough to run every few minutes for
 * an inbox a person also uses for their actual job. When that id has aged out
 * — Google keeps roughly a week of history — it falls back to a time-boxed
 * message list rather than giving up.
 */

/** Messages examined in one pass per inbox. A person's inbox is not a queue. */
const MAX_MESSAGES_PER_PASS = 40;

/** How far back the fallback read looks when the history id is unusable. */
const FALLBACK_WINDOW_HOURS = 48;

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

export interface GmailSyncResult {
  accounts: number;
  examined: number;
  matched: number;
  errors: number;
}

function headerOf(message: GmailMessage, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/** `Dana Reeves <dana@acme.com>` → `dana@acme.com`. */
export function extractAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const bracketed = raw.match(/<([^>]+)>/);
  const candidate = (bracketed ? bracketed[1] : raw).trim().toLowerCase();
  return candidate.includes('@') ? candidate : undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * The readable text of a Gmail message.
 *
 * Prefers text/plain wherever it appears in the MIME tree, because that is what
 * the sender typed. An HTML-only reply is stripped to something a language
 * model can read rather than dropped — a prospect answering from Outlook on a
 * phone routinely sends no plain part at all, and losing those replies would be
 * losing exactly the ones worth having.
 */
export function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return '';

  const collect = (node: GmailPayload, mime: string): string | null => {
    if (node.mimeType === mime && node.body?.data) return decodeBase64Url(node.body.data);
    for (const part of node.parts || []) {
      const found = collect(part, mime);
      if (found) return found;
    }
    return null;
  };

  const plain = collect(payload, 'text/plain');
  if (plain) return plain;

  const html = collect(payload, 'text/html');
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

/**
 * Strip the quoted history off a reply.
 *
 * The whole prior thread rides along on every Gmail reply, and handing that to
 * the SDR agent means it re-reads its own last email as though the lead had
 * written it — which is both expensive and a reliable way to produce a reply
 * that answers the wrong message. Only the part above the quote is new.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((line) =>
    /^\s*(On .{10,80}wrote:|-{2,}\s*Original Message|_{5,}|From:\s)/i.test(line)
  );
  const head = cut > 0 ? lines.slice(0, cut) : lines;
  // Drop a trailing run of quoted lines even when no attribution line was found.
  while (head.length && /^\s*>/.test(head[head.length - 1])) head.pop();
  return head.join('\n').trim() || body.trim();
}

/** Message ids that arrived since the last pass, newest-first. */
async function newMessageIds(account: GmailAccount): Promise<{
  ids: string[];
  historyId?: string;
}> {
  if (account.lastHistoryId) {
    try {
      const history = await callGmail<{
        history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
        historyId?: string;
      }>(
        account,
        `/history?startHistoryId=${encodeURIComponent(account.lastHistoryId)}` +
          `&historyTypes=messageAdded&labelId=INBOX&maxResults=${MAX_MESSAGES_PER_PASS}`
      );
      const ids = (history.history || [])
        .flatMap((entry) => entry.messagesAdded || [])
        .map((added) => added.message.id);
      return { ids: [...new Set(ids)], historyId: history.historyId };
    } catch (err) {
      // 404 means the history id has aged out of Google's window. Anything else
      // is a real failure and should surface, not be papered over by a scan.
      const status = (err as Error & { status?: number }).status;
      if (status !== 404) throw err;
    }
  }

  const after = Math.floor(
    (account.lastSyncAt?.getTime() ?? Date.now() - FALLBACK_WINDOW_HOURS * 3600 * 1000) / 1000
  );
  const listed = await callGmail<{ messages?: { id: string }[] }>(
    account,
    `/messages?q=${encodeURIComponent(`in:inbox -in:chats after:${after}`)}` +
      `&maxResults=${MAX_MESSAGES_PER_PASS}`
  );
  const profile = await callGmail<{ historyId?: string }>(account, '/profile').catch(
    () => null
  );
  return { ids: (listed.messages || []).map((m) => m.id), historyId: profile?.historyId };
}

/**
 * Read one inbox and thread anything new onto its lead.
 *
 * Everything that is not a reply to us is simply skipped: this reads a person's
 * real inbox, most of which is none of the platform's business. A message is
 * only ingested when `handleInbound` can tie its sender to a lead this
 * organization already has, which is the same rule the Mailgun webhook follows.
 */
export async function syncGmailAccount(account: GmailAccount): Promise<GmailSyncResult> {
  const result: GmailSyncResult = { accounts: 1, examined: 0, matched: 0, errors: 0 };
  const { ids, historyId } = await newMessageIds(account);

  for (const id of ids.slice(0, MAX_MESSAGES_PER_PASS)) {
    result.examined++;
    const message = await callGmail<GmailMessage>(account, `/messages/${id}?format=full`).catch(
      () => null
    );
    if (!message) {
      result.errors++;
      continue;
    }

    // Our own sends come back through history too — ingesting one would file
    // our email as though the lead had written it.
    if (message.labelIds?.includes('SENT') || message.labelIds?.includes('DRAFT')) continue;
    const fromEmail = extractAddress(headerOf(message, 'From'));
    if (!fromEmail || fromEmail === account.emailAddress.toLowerCase()) continue;

    const body = stripQuotedReply(extractBody(message.payload)) || message.snippet || '';
    if (!body.trim()) continue;

    const inbound = await handleInbound({
      organizationId: account.organizationId,
      channel: 'EMAIL',
      fromEmail,
      subject: headerOf(message, 'Subject'),
      body,
      // Gmail's own id, not the RFC header: it is stable, unique per account,
      // and it is what a repeated pass would hand us again.
      externalId: message.id,
      toEmailDomain: account.emailAddress.split('@')[1],
    });
    if (inbound.matched) {
      result.matched++;
      // Keep the thread anchored so our reply lands inside it rather than
      // starting a second conversation in the prospect's inbox.
      if (message.threadId && inbound.conversationId) {
        await prisma.conversation
          .updateMany({
            where: { id: inbound.conversationId, externalThreadId: null },
            data: { externalThreadId: message.threadId, gmailAccountId: account.id },
          })
          .catch(() => undefined);
      }
      // Record the reply's Message-ID so the answer threads for the recipient,
      // not just inside Gmail.
      const headerId = headerOf(message, 'Message-ID');
      if (headerId && inbound.conversationId) {
        await prisma.message
          .updateMany({
            where: { conversationId: inbound.conversationId, externalId: message.id },
            data: { headerMessageId: headerId, gmailAccountId: account.id },
          })
          .catch(() => undefined);
      }
    }
  }

  await prisma.gmailAccount
    .update({
      where: { id: account.id },
      data: { lastSyncAt: new Date(), ...(historyId ? { lastHistoryId: historyId } : {}) },
    })
    .catch(() => undefined);

  return result;
}

/**
 * Read every connected inbox on the deployment.
 *
 * Runs inside the worker's time sweep next to the social inbox sweep, for the
 * same reason: a channel the platform can send on but never hears back from is
 * a channel that quietly loses every reply.
 */
export async function runGmailSyncSweep(): Promise<GmailSyncResult> {
  const totals: GmailSyncResult = { accounts: 0, examined: 0, matched: 0, errors: 0 };
  const accounts = await prisma.gmailAccount.findMany({ where: { status: 'CONNECTED' } });

  for (const account of accounts) {
    totals.accounts++;
    try {
      const one = await syncGmailAccount(account);
      totals.examined += one.examined;
      totals.matched += one.matched;
      totals.errors += one.errors;
    } catch (err) {
      totals.errors++;
      // An expired grant has already marked itself; anything else is recorded
      // so the operator sees why an inbox stopped bringing replies in.
      if (!(err instanceof GmailAuthError)) {
        await prisma.gmailAccount
          .update({
            where: { id: account.id },
            data: { lastError: (err instanceof Error ? err.message : 'sync failed').slice(0, 400) },
          })
          .catch(() => undefined);
      }
    }
  }
  return totals;
}
