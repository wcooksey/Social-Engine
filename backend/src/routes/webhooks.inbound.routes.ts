import { Router } from 'express';
import { config } from '../config/environment';
import { asyncHandler } from '../middleware/error.middleware';
import { handleInbound } from '../services/inbound.service';

const router = Router();

function checkSecret(provided: unknown): boolean {
  const secret = config.inbound.webhookSecret;
  if (!secret) return true; // no secret set → accept (dev)
  return provided === secret;
}

/**
 * Mailgun inbound-route webhook (form-encoded). Configure a Mailgun Route to
 * forward to {API_URL}/api/webhooks/inbound/email?secret=INBOUND_WEBHOOK_SECRET.
 */
router.post(
  '/email',
  asyncHandler(async (req, res) => {
    if (!checkSecret(req.query.secret)) {
      res.status(401).json({ success: false, error: 'Invalid secret' });
      return;
    }
    const body = req.body || {};
    const fromEmail = extractEmail(body.sender || body.from || body.From);
    const text = body['stripped-text'] || body['body-plain'] || body.text || '';
    const subject = body.subject || body.Subject;

    const result = await handleInbound({
      channel: 'EMAIL',
      fromEmail,
      subject,
      body: String(text),
      externalId: body['Message-Id'] || body['message-id'],
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
      res.status(401).json({ success: false, error: 'Invalid secret' });
      return;
    }
    const body = req.body || {};
    const result = await handleInbound({
      channel: 'SMS',
      fromPhone: body.From,
      body: String(body.Body || ''),
      externalId: body.MessageSid,
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
      res.status(401).json({ success: false, error: 'Invalid secret' });
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

function extractEmail(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/[^<\s]+@[^>\s]+/);
  return match ? match[0].toLowerCase() : undefined;
}

export default router;
