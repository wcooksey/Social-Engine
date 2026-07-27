import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config/environment';
import { prisma } from '../config/database';
import { asyncHandler } from '../middleware/error.middleware';
import { handleInbound } from '../services/inbound.service';
import { recomputeLeadEnrichment } from '../services/lead-enrichment.service';

const router = Router();

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
    const result = await handleInbound({
      channel: 'EMAIL',
      fromEmail,
      subject,
      body: String(text),
      externalId: body['Message-Id'] || body['message-id'],
      toEmailDomain: recipient?.split('@')[1],
    });
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
    // Twilio expects TwiML (empty response is fine — no auto-reply here)
    res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    void result;
  })
);

/**
 * Generic social inbound. Forward DMs from a bridge (ManyChat / GoHighLevel /
 * Make / a native Graph API webhook) here as JSON so the AI can reply two-way.
 * Match by socialHandle, or pass leadId/contactId directly if the bridge knows them.
 */
router.post(
  '/social',
  asyncHandler(async (req, res) => {
    if (!checkSecret(req.query.secret || req.headers['x-inbound-secret'])) {
      rejectUnauthorized(res);
      return;
    }
    const body = req.body || {};
    const result = await handleInbound({
      organizationId: body.organizationId,
      channel: 'SOCIAL',
      socialHandle: body.socialHandle || body.from,
      leadId: body.leadId,
      contactId: body.contactId,
      body: String(body.text || body.message || ''),
      externalId: body.id,
    });
    res.json({ success: true, data: result });
  })
);

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

    // Engagement events: mark the message opened/clicked and log the first
    // occurrence on the lead timeline — a warmth signal the SDR agents can
    // read (get_lead_timeline) to prioritize and time follow-ups.
    if (event === 'opened' || event === 'clicked') {
      const messageId = String(data?.message?.headers?.['message-id'] || '').replace(
        /^<|>$/g,
        ''
      );
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
      // Status only moves forward: sent -> opened -> clicked. Repeat events
      // (every re-open fires a webhook) neither regress it nor re-log.
      const firstOfKind =
        event === 'clicked' ? message.status !== 'clicked' : message.status === 'sent';
      if (firstOfKind) {
        await prisma.message.update({
          where: { id: message.id },
          data: { status: event },
        });
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
    const contacts = await prisma.contact.findMany({ where: { email: recipient } });
    for (const contact of contacts) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { emailStatus: status, ...(isComplaint ? { optedOut: true } : {}) },
      });
      // A spam complaint is a hard opt-out signal across all channels.
      if (isComplaint) {
        await prisma.lead.update({ where: { id: contact.leadId }, data: { doNotContact: true } });
      }
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

function extractEmail(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/[^<\s]+@[^>\s]+/);
  return match ? match[0].toLowerCase() : undefined;
}

export default router;
