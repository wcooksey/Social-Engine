/**
 * Outbound channel delivery. Credentials are resolved per-organization (from
 * settings, falling back to env) and passed in, so each account uses its own
 * Mailgun/Twilio/Vapi. Each channel reports whether it's configured; the
 * Engine's send tools fall back to drafts when a channel isn't ready.
 */

export interface SendResult {
  sent: boolean;
  externalId?: string;
  error?: string;
}

export interface EmailCreds {
  apiKey: string;
  domain: string;
}
export interface SmsCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}
export interface VoiceCreds {
  apiKey: string;
  phoneNumberId: string;
  assistantModel: string;
  voiceProvider: string;
  voiceId: string;
}

// ---------------------------------------------------------------------------
// Email — Mailgun
// ---------------------------------------------------------------------------

export function isEmailConfigured(creds: EmailCreds): boolean {
  return !!(creds.apiKey && creds.domain);
}

export async function sendEmail(
  opts: { to: string; subject: string; body: string; fromName?: string },
  creds: EmailCreds
): Promise<SendResult> {
  if (!isEmailConfigured(creds)) return { sent: false, error: 'Email channel not configured' };

  const from = `${opts.fromName || 'Social Engine'} <noreply@${creds.domain}>`;
  const form = new URLSearchParams({ from, to: opts.to, subject: opts.subject, text: opts.body });

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${creds.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${creds.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
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

export function isSmsConfigured(creds: SmsCreds): boolean {
  return !!(creds.accountSid && creds.authToken && creds.fromNumber);
}

export async function sendSms(opts: { to: string; body: string }, creds: SmsCreds): Promise<SendResult> {
  if (!isSmsConfigured(creds)) return { sent: false, error: 'SMS channel not configured' };

  const form = new URLSearchParams({ From: creds.fromNumber, To: opts.to, Body: opts.body });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
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

export function isVoiceConfigured(creds: VoiceCreds): boolean {
  return !!(creds.apiKey && creds.phoneNumberId);
}

export async function placeVapiCall(
  opts: {
    toNumber: string;
    systemPrompt: string;
    firstMessage: string;
    metadata: Record<string, string>;
  },
  creds: VoiceCreds
): Promise<SendResult> {
  if (!isVoiceConfigured(creds)) return { sent: false, error: 'Voice channel not configured' };

  try {
    const res = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: creds.phoneNumberId,
        customer: { number: opts.toNumber },
        metadata: opts.metadata,
        assistant: {
          firstMessage: opts.firstMessage,
          model: {
            provider: 'openai',
            model: creds.assistantModel,
            messages: [{ role: 'system', content: opts.systemPrompt }],
          },
          voice: { provider: creds.voiceProvider, voiceId: creds.voiceId },
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
