import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config/environment';
import { prisma } from '../config/database';
import { asyncHandler } from '../middleware/error.middleware';
import { multipartFormData } from '../middleware/multipart.middleware';
import { handleInbound } from '../services/inbound.service';
import { recomputeLeadEnrichment } from '../services/lead-enrichment.service';
import { recordMailboxEvent } from '../services/sender.service';
import { suppress } from '../services/suppression.service';
import { resolveOrg } from '../services/settings.service';

const router = Router();

// Mailgun posts parsed inbound mail as multipart/form-data, which the app-wide
// json/urlencoded parsers skip. Without this every reply arrives as an empty
// body and is dropped. A no-op for the JSON and urlencoded webhooks below.
router.use(multipartFormData());

/**
 * A reply the provider handed us but we couldn't record. Logged loudly and
 * echoed in the response body, so it shows up in the provider's webhook log
 * instead of looking like a clean 200.
 */
function logDropped(channel: string, detail: string, context: Record<string, unknown>): void {
  console.warn(`[inbound:${channel}] dropped — ${detail}`, context);
}

// Fail closed: inbound endpoints refuse all traffic until a shared secret is
// configured. These webhooks inject lead messages and trigger autonomous
// agent replies, so anonymous access is never acceptable.
function checkSecret(provided: unknown): boolean {
  const secret = config.inbound.webhookSecret;
  if (!secret) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rejectUnauthorized(res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  const reason = config.inbound.webhookSecret
    ? 'Invalid secret'
    : 'Inbound webhooks disabled — set INBOUND_WEBHOOK_SECRET to enable';
  res.status(401).json({ success: false, error: reason });
}

/**
 * Mailgun inbound-route webhook (form-encoded). Configure a Mailgun Route to
 * forward to {API_URL}/api/webhooks/inbound/email?secret=INBOUND_WEBHOOK_SECRET.
 */
router.post(
  '/email',
  asyncHandler(async (req, res) => {
    if (!checkSecret(req.query.secret)) {
      rejectUnauthorized(res);
      return;
    }
    const body = req.body || {};
    const fromEmail = extractEmail(body.sender || body.from || body.From);
    const text = body['stripped-text'] || body['body-plain'] || body.text || '';
    const subject = body.subject || body.Subject;
    const recipient = extractEmail(body.recipient || body.To || body.to);

    // No sender means the payload never parsed — almost always a content type
    // we didn't read, not a real email. Say so rather than reporting success.
    if (!fromEmail) {
      const detail = Object.keys(body).length
        ? 'no sender address in the payload'
        : `empty body (content-type: ${req.headers['content-type'] || 'none'})`;
      logDropped('email', detail, { fields: Object.keys(body) });
      res.status(422).json({ success: false, error: detail });
      return;
    }

    const result = await handleInbound({
      channel: 'EMAIL',
      fromEmail,
      subject,
      body: String(text),
      externalId: body['Message-Id'] || body['message-id'],
      toEmailDomain: recipient?.split('@')[1],
    });
    if (!result.matched) {
      logDropped('email', result.reason || 'no match', { fromEmail, recipient });
    }
    res.json({ success: true, data: result });
  })
);

/**
 * Twilio inbound SMS webhook (form-encoded). Point your Twilio number's
 * messaging webhook at {API_URL}/api/webhooks/inbound/sms?secret=...
 */
router.post(
  '/sms',
  asyncHandler(async (req, res) => {
    if (!checkSecret(req.query.secret)) {
      rejectUnauthorized(res);
      return;
    }
    const body = req.body || {};
    const result = await handleInbound({
      channel: 'SMS',
      fromPhone: body.From,
      body: String(body.Body || ''),
      externalId: body.MessageSid,
      toPhone: body.To,
    });
    if (!result.matched) {
      logDropped('sms', result.reason || 'no match', { from: body.From, to: body.To });
    }
    // Twilio expects TwiML (empty response is fine — no auto-reply here)
    res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  })
);

/**
 * Which organization a social webhook call is for.
 *
 * The tenant is derived from the SECRET, never from the request body. Email and
 * SMS resolve their org from the recipient address or number, which the sender
 * cannot choose; social bridges have no such anchor, so a body-supplied
 * organizationId behind one deployment-wide secret let anyone holding that
 * secret write a fabricated reply into any tenant — flipping a lead to engaged,
 * pausing its cadence and queueing an SDR job carrying the attacker's text.
 *
 * A per-organization secret (Settings → Integrations) identifies the tenant on
 * its own. The deployment-wide secret still works, but only where it cannot be
 * ambiguous: a single-organization install.
 */
async function resolveSocialOrg(
  slug: string | undefined,
  provided: unknown
): Promise<{ organizationId?: string; error?: string }> {
  if (typeof provided !== 'string' || provided.length === 0) {
    return { error: 'missing secret' };
  }

  if (slug) {
    const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!org) return { error: 'unknown organization' };
    const secret = await resolveOrg(org.id, 'INBOUND_WEBHOOK_SECRET');
    if (!secret || !timingSafeMatch(provided, secret)) return { error: 'bad secret' };
    return { organizationId: org.id };
  }

  // No slug: only safe when the deployment holds a single organization, since
  // the platform secret says nothing about which tenant is meant.
  if (!checkSecret(provided)) return { error: 'bad secret' };
  const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 });
  if (orgs.length === 1) return { organizationId: orgs[0].id };
  return {
    error:
      'this deployment hosts multiple organizations — post to /api/webhooks/inbound/social/<org-slug> with that organization\'s own inbound webhook secret',
  };
}

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Generic social inbound. Forward DMs from a bridge (ManyChat / GoHighLevel /
 * Make / a native Graph API webhook) here as JSON so the AI can reply two-way.
 * Match by socialHandle, or pass leadId/contactId directly if the bridge knows them.
 */
const handleSocialInbound = asyncHandler(async (req, res) => {
  const resolved = await resolveSocialOrg(
    req.params.orgSlug,
    req.query.secret || req.headers['x-inbound-secret']
  );
  if (!resolved.organizationId) {
    // Deliberately terse to the caller; the reason is logged, not returned.
    console.warn(`Inbound social rejected: ${resolved.error}`);
    rejectUnauthorized(res);
    return;
  }

  const body = req.body || {};
  const result = await handleInbound({
    // From the authenticated secret, never from the body.
    organizationId: resolved.organizationId,
    channel: 'SOCIAL',
    socialHandle: body.socialHandle || body.from,
    leadId: body.leadId,
    contactId: body.contactId,
    body: String(body.text || body.message || ''),
    externalId: body.id,
  });
  if (!result.matched) {
    logDropped('social', result.reason || 'no match', {
      handle: body.socialHandle || body.from,
      organizationId: resolved.organizationId,
    });
  }
  res.json({ success: true, data: result });
});

router.post('/social', handleSocialInbound);
router.post('/social/:orgSlug', handleSocialInbound);

/**
 * Mailgun event webhook (deliverability). Point Mailgun's "permanent failure"
 * and "spam complaint" webhooks at
 * {API_URL}/api/webhooks/inbound/mailgun-events?secret=INBOUND_WEBHOOK_SECRET.
 * Suppresses the offending address so we stop mailing bounced/complained
 * contacts — protecting sender reputation and deliverability.
 */
router.post(
  '/mailgun-events',
  asyncHandler(async (req, res) => {
    if (!checkSecret(req.query.secret)) {
      rejectUnauthorized(res);
      return;
    }
    const data = (req.body?.['event-data'] || req.body) as Record<string, any>;
    const event = String(data?.event || '');
    const recipient = extractEmail(data?.recipient);
    if (!recipient) {
      res.json({ success: true, data: { ignored: 'no recipient' } });
      return;
    }
    const messageId = String(data?.message?.headers?.['message-id'] || '').replace(/^<|>$/g, '');

    // Record only authenticated events correlated to one of our messages.
    if (messageId && ['delivered', 'opened', 'clicked', 'failed', 'complained'].includes(event)) {
      const matched = await prisma.message.findFirst({ where: { externalId: messageId, direction: 'OUTBOUND' }, select: { mailboxId: true, conversation: { select: { organizationId: true } } } });
      if (matched) await prisma.emailEventReceipt.create({ data: { organizationId: matched.conversation.organizationId, mailboxId: matched.mailboxId, event } });
    }

    // Delivery + engagement events: advance the message's state, credit the
    // sending mailbox, and log opens/clicks on the lead timeline as a warmth
    // signal the SDR agents read (get_lead_timeline) to time follow-ups.
    if (event === 'delivered' || event === 'opened' || event === 'clicked') {
      if (!messageId) {
        res.json({ success: true, data: { ignored: 'no message-id' } });
        return;
      }
      const message = await prisma.message.findFirst({
        where: { externalId: messageId, direction: 'OUTBOUND' },
        include: { conversation: { select: { organizationId: true, leadId: true } } },
      });
      if (!message) {
        res.json({ success: true, data: { ignored: 'unknown message' } });
        return;
      }
      // Repeat events (every re-open fires a webhook) neither regress the
      // status nor re-log, and a late 'delivered' can't undo a recorded open.
      const firstOfKind =
        EMAIL_STATUS_RANK[event] > (EMAIL_STATUS_RANK[message.status || ''] ?? 0);
      if (firstOfKind) {
        await prisma.message.update({ where: { id: message.id }, data: { status: event } });
        // A click implies an open but fires its own webhook; counting only the
        // 'opened' event keeps the per-mailbox rate from double-counting.
        if (message.mailboxId && event !== 'clicked') {
          // Delivery belongs to the day of the send; an open belongs to the day
          // the recipient opened it.
          await recordMailboxEvent(
            message.mailboxId,
            event,
            event === 'delivered' ? (message.sentAt ?? new Date()) : new Date()
          );
        }
        if (event !== 'delivered') {
          await prisma.activity.create({
            data: {
              organizationId: message.conversation.organizationId,
              leadId: message.conversation.leadId,
              type: event === 'clicked' ? 'EMAIL_CLICKED' : 'EMAIL_OPENED',
              summary:
                event === 'clicked'
                  ? `Email link clicked by ${recipient}${data?.url ? ` (${String(data.url).slice(0, 120)})` : ''}`
                  : `Email opened by ${recipient}`,
              payload: { emailEvent: event, recipient, ...(data?.url ? { url: data.url } : {}) },
            },
          });
        }
      }
      res.json({ success: true, data: { processed: event, firstOfKind } });
      return;
    }

    const isComplaint = event === 'complained';
    const isHardBounce =
      event === 'failed' && String(data?.severity || '').toLowerCase() === 'permanent';
    if (!isComplaint && !isHardBounce) {
      res.json({ success: true, data: { ignored: event } });
      return;
    }

    const status = isComplaint ? 'complained' : 'bounced';

    // Charge it to the mailbox that sent it. Suppressing the recipient protects
    // the next send; this is what makes a domain going bad visible at all.
    //
    // The message also carries the only reliable answer to WHOSE send this was:
    // `recipient` is the prospect's address, and two organizations can each
    // legitimately hold the same prospect. This endpoint authenticates on the
    // deployment-wide secret alone, so without it there is no tenant context.
    let ownerOrgId: string | null = null;
    if (messageId) {
      const message = await prisma.message.findFirst({
        where: { externalId: messageId, direction: 'OUTBOUND' },
        select: {
          id: true,
          mailboxId: true,
          status: true,
          sentAt: true,
          conversation: { select: { organizationId: true } },
        },
      });
      ownerOrgId = message?.conversation.organizationId ?? null;
      // Same forward-only ladder as the engagement events. Mailgun redelivers on
      // any non-2xx, and counting one bounce twice is enough to push a mailbox
      // over the threshold and pause a sender that was never actually failing.
      const advances =
        !!message && EMAIL_STATUS_RANK[status] > (EMAIL_STATUS_RANK[message.status || ''] ?? 0);
      if (message && advances) {
        await prisma.message.update({ where: { id: message.id }, data: { status } });
        if (message.mailboxId) {
          // Charged to the day the mail went out, not the day the failure came
          // back. A bounce from before a pause would otherwise land inside the
          // resumed mailbox's fresh window, against a denominator that excludes
          // the sends that caused it.
          await recordMailboxEvent(
            message.mailboxId,
            isComplaint ? 'complained' : 'bounced',
            message.sentAt ?? new Date()
          );
        }
      }
    }

    // Scoped to the organization whose message actually bounced. Unscoped, a
    // bounce for an address two tenants both hold marked BOTH of their contacts
    // — and on a complaint, opted out a lead belonging to someone who never
    // sent the mail. When the owner cannot be identified (no message-id on the
    // event, or the message has since been deleted) fall back to the previous
    // org-wide behaviour rather than dropping the suppression: mailing a known
    // bad address again is the worse failure.
    const contacts = await prisma.contact.findMany({
      where: { email: recipient, ...(ownerOrgId ? { organizationId: ownerOrgId } : {}) },
    });
    if (!ownerOrgId) {
      console.warn(
        `Mailgun ${event} for ${recipient} carried no resolvable message — suppressing across ` +
          `${contacts.length} matching contact(s) without tenant scoping.`
      );
    }
    for (const contact of contacts) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { emailStatus: status, ...(isComplaint ? { optedOut: true } : {}) },
      });
      // A spam complaint is a hard opt-out signal across all channels.
      if (isComplaint) {
        await prisma.lead.update({ where: { id: contact.leadId }, data: { doNotContact: true } });
      }
      // Both outcomes earn a permanent record, not just complaints. A hard
      // bounce previously survived only as a field on the contact, which
      // cascades away with its lead — so deleting a bounced lead and
      // re-sourcing the business meant mailing the dead address all over again
      // and earning the bounce a second time.
      await suppress({
        organizationId: contact.organizationId,
        kind: 'EMAIL',
        value: recipient,
        reason: isComplaint ? 'Marked our mail as spam' : `Email ${status}`,
        source: isComplaint ? 'spam_complaint' : 'hard_bounce',
        originLeadId: contact.leadId,
      });
      // A dead/complained address stops counting as a usable email — the lead's
      // enrichment tier must reflect that it just got harder to reach.
      await recomputeLeadEnrichment(contact.leadId);
      await prisma.activity.create({
        data: {
          organizationId: contact.organizationId,
          leadId: contact.leadId,
          type: 'STATUS_CHANGE',
          summary: `Email ${status} for ${recipient} — address suppressed.`,
          payload: { emailEvent: event, recipient },
        },
      });
    }
    res.json({ success: true, data: { processed: contacts.length, status } });
  })
);

/**
 * Outbound email status ladder — provider events only move a message forward.
 * Failures rank above every engagement state because they are terminal: a
 * stray open event arriving after a bounce must not report the mail as read.
 */
const EMAIL_STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 90,
  complained: 90,
};

function extractEmail(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/[^<\s]+@[^>\s]+/);
  return match ? match[0].toLowerCase() : undefined;
}

export default router;
