import { config } from '../config/environment';

/**
 * Outbound channel delivery. Each channel reports whether it's configured;
 * the Engine's send tools fall back to drafts when a channel isn't ready.
 */

export interface SendResult {
  sent: boolean;
  externalId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Email — Mailgun
// ---------------------------------------------------------------------------

export function isEmailConfigured(): boolean {
  return !!(config.mailgun.apiKey && config.mailgun.domain);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
}): Promise<SendResult> {
  if (!isEmailConfigured()) return { sent: false, error: 'Email channel not configured' };

  const from = `${opts.fromName || 'Social Engine'} <noreply@${config.mailgun.domain}>`;
  const form = new URLSearchParams({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
  });

  try {
    const res = await fetch(
      `https://api.mailgun.net/v3/${config.mailgun.domain}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${config.mailgun.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { sent: false, error: `Mailgun ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as { id?: string };
    return { sent: true, externalId: body.id };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'Email send failed' };
  }
}

// ---------------------------------------------------------------------------
// SMS — Twilio
// ---------------------------------------------------------------------------

export function isSmsConfigured(): boolean {
  return !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber);
}

export async function sendSms(opts: { to: string; body: string }): Promise<SendResult> {
  if (!isSmsConfigured()) return { sent: false, error: 'SMS channel not configured' };

  const form = new URLSearchParams({
    From: config.twilio.fromNumber,
    To: opts.to,
    Body: opts.body,
  });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${config.twilio.accountSid}:${config.twilio.authToken}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { sent: false, error: `Twilio ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as { sid?: string };
    return { sent: true, externalId: body.sid };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'SMS send failed' };
  }
}

// ---------------------------------------------------------------------------
// Voice — Vapi (AI phone calls)
// ---------------------------------------------------------------------------

export function isVoiceConfigured(): boolean {
  return !!(config.vapi.apiKey && config.vapi.phoneNumberId);
}

export async function placeVapiCall(opts: {
  toNumber: string;
  systemPrompt: string;
  firstMessage: string;
  /** Opaque metadata echoed back in webhooks (leadId etc.). */
  metadata: Record<string, string>;
}): Promise<SendResult> {
  if (!isVoiceConfigured()) return { sent: false, error: 'Voice channel not configured' };

  try {
    const res = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.vapi.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: config.vapi.phoneNumberId,
        customer: { number: opts.toNumber },
        metadata: opts.metadata,
        assistant: {
          firstMessage: opts.firstMessage,
          model: {
            provider: 'openai',
            model: config.vapi.assistantModel,
            messages: [{ role: 'system', content: opts.systemPrompt }],
          },
          voice: { provider: config.vapi.voiceProvider, voiceId: config.vapi.voiceId },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { sent: false, error: `Vapi ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as { id?: string };
    return { sent: true, externalId: body.id };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'Call placement failed' };
  }
}
