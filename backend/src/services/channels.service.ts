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
  /** Sender address; blank falls back to noreply@<domain>. Must be on the domain. */
  fromEmail?: string;
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

/** Sender address for a set of email creds (configured address, else noreply@domain). */
export function senderAddress(creds: EmailCreds): string {
  const configured = creds.fromEmail?.trim();
  return configured || `noreply@${creds.domain}`;
}

export interface IcsAttachment {
  filename: string; // e.g. "invite.ics"
  content: string; // raw iCalendar text
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  /** Optional HTML alternative part. */
  html?: string;
  /** RFC 2369 List-Unsubscribe target (mailto: or https:). Adds one-click too. */
  unsubscribeUrl?: string;
  /** Calendar invite to attach (renders as an "add to calendar" invite). */
  ics?: IcsAttachment;
}

export async function sendEmail(opts: SendEmailOptions, creds: EmailCreds): Promise<SendResult> {
  if (!isEmailConfigured(creds)) return { sent: false, error: 'Email channel not configured' };

  const from = `${opts.fromName || 'Social Engine'} <${senderAddress(creds)}>`;

  // Multipart form so we can attach an .ics calendar invite alongside the text.
  const form = new FormData();
  form.append('from', from);
  form.append('to', opts.to);
  form.append('subject', opts.subject);
  form.append('text', opts.body);
  if (opts.html) form.append('html', opts.html);
  if (opts.unsubscribeUrl) {
    // Header value differs for mailto vs http; add one-click for http targets.
    const value = opts.unsubscribeUrl.startsWith('mailto:')
      ? `<${opts.unsubscribeUrl}>`
      : `<${opts.unsubscribeUrl}>`;
    form.append('h:List-Unsubscribe', value);
    if (!opts.unsubscribeUrl.startsWith('mailto:')) {
      form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }
  }
  if (opts.ics) {
    form.append(
      'attachment',
      new Blob([opts.ics.content], { type: 'text/calendar; method=REQUEST' }),
      opts.ics.filename
    );
  }

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${creds.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${creds.apiKey}`).toString('base64')}`,
      },
      body: form,
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
    /** Spoken if the call lands in voicemail (detection enabled when set). */
    voicemailMessage?: string;
    metadata: Record<string, string>;
    /** Where Vapi should POST the end-of-call report, with a shared secret
     *  (sent as the X-Vapi-Secret header). Set per-call so no Vapi dashboard
     *  Server URL config is needed. */
    server?: { url: string; secret: string };
    /**
     * Actions the assistant may take DURING the call — texting a link, checking
     * the calendar, booking, capturing a callback. Vapi calls back to our
     * webhook mid-conversation and speaks the result, so "I'll text that over
     * right now" actually happens while they're still on the line.
     */
    tools?: unknown[];
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
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
          ...(opts.server
            ? {
                server: { url: opts.server.url, secret: opts.server.secret },
                // tool-calls must be delivered too, or mid-call actions never
                // reach us and the assistant only *claims* it sent the text.
                serverMessages: opts.tools?.length
                  ? ['end-of-call-report', 'tool-calls']
                  : ['end-of-call-report'],
              }
            : {}),
          ...(opts.voicemailMessage
            ? {
                voicemailMessage: opts.voicemailMessage,
                voicemailDetection: { provider: 'twilio' },
              }
            : {}),
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
