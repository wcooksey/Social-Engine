import { config } from '../config/environment';
import type { EmailCreds } from './channels.service';
import { isEmailConfigured, mailgunGet } from './channels.service';

/**
 * Inbound email readiness.
 *
 * Sending mail and receiving replies are two independent setups in Mailgun, and
 * a send-only domain looks perfectly healthy right up until a lead hits reply.
 * This walks the whole chain a reply has to survive — MX records, a route, the
 * shared secret, this deployment's public URL — and names the first broken
 * link, so "my reply never showed up in the inbox" has an answer.
 */

export interface InboundCheck {
  key: 'secret' | 'publicUrl' | 'mailgun' | 'mx' | 'route' | 'gmail';
  label: string;
  /** null when the check couldn't run (a prerequisite failed, or Mailgun errored). */
  ok: boolean | null;
  detail: string;
}

export interface InboundHealth {
  ok: boolean;
  /** Paste-ready target for the Mailgun route; the secret stays masked. */
  webhookUrl: string;
  checks: InboundCheck[];
}

/** Connected inboxes, as this check needs to see them. */
export interface InboundGmailAccount {
  emailAddress: string;
  status: string;
  lastSyncAt: Date | null;
}

/** Pull the URL out of a Mailgun route action like `forward("https://…")`. */
function forwardTargets(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((a) => String(a).match(/^forward\((?:"|')(.+?)(?:"|')\)$/)?.[1])
    .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
}

export async function checkInboundEmail(
  creds: EmailCreds,
  /**
   * Connected Gmail inboxes. Replies to these are polled rather than forwarded,
   * so none of the webhook chain below applies to them — reporting a missing
   * Mailgun route as the reason replies aren't arriving would send someone to
   * fix DNS for a transport that has no DNS.
   */
  gmailAccounts: InboundGmailAccount[] = [],
  registeredDomains: string[] = []
): Promise<InboundHealth> {
  // Registered sending domains own the Mailgun reply path. The legacy domain
  // can legitimately receive through Google; do not suggest replacing its MX.
  const domains = [...new Set(registeredDomains.map(d => d.trim().toLowerCase()).filter(Boolean))];
  if (domains.length) {
    const reports = await Promise.all(domains.map((domain, index) =>
      checkInboundEmail({ ...creds, domain }, index === 0 ? gmailAccounts : [])
    ));
    const checks = reports.flatMap((report, index) => report.checks
      .filter(check => index === 0 || !['secret', 'publicUrl', 'gmail'].includes(check.key))
      .map(check => ['mx', 'route', 'mailgun'].includes(check.key)
        ? { ...check, label: `${domains[index]} — ${check.label}` }
        : check));
    return { ok: checks.every(check => check.ok === true), webhookUrl: reports[0].webhookUrl, checks };
  }
  const secret = config.inbound.webhookSecret;
  const expectedPath = '/api/webhooks/inbound/email';
  const webhookUrl = `${config.appPublicUrl}${expectedPath}?secret=${
    secret ? 'YOUR_INBOUND_WEBHOOK_SECRET' : 'set-INBOUND_WEBHOOK_SECRET-first'
  }`;

  const checks: InboundCheck[] = [];

  const liveInboxes = gmailAccounts.filter((a) => a.status === 'CONNECTED');
  if (gmailAccounts.length > 0) {
    checks.push({
      key: 'gmail',
      label: 'Connected Gmail inboxes',
      ok: liveInboxes.length > 0,
      detail: liveInboxes.length
        ? `Replies to ${liveInboxes
            .map((a) => a.emailAddress)
            .join(', ')} are read directly from the inbox every few minutes — no MX records, route or webhook secret involved.${
            liveInboxes.every((a) => !a.lastSyncAt)
              ? ' No sweep has run yet; the first one happens within a few minutes.'
              : ''
          }`
        : `Every connected inbox is ${gmailAccounts
            .map((a) => a.status.toLowerCase())
            .join('/')} — reconnect it under Settings → Sending, or replies stop arriving.`,
    });
  }

  // With no Mailgun at all and a healthy inbox, the chain below is not merely
  // passing — it is irrelevant, and every "not configured" line in it would be
  // an answer to a question nobody asked.
  if (!isEmailConfigured(creds) && liveInboxes.length > 0) {
    return { ok: true, webhookUrl, checks };
  }

  checks.push({
    key: 'secret',
    label: 'Inbound webhook secret',
    ok: !!secret,
    detail: secret
      ? 'INBOUND_WEBHOOK_SECRET is set — inbound webhooks are enabled.'
      : 'INBOUND_WEBHOOK_SECRET is not set on this deployment. Inbound webhooks fail closed: every reply is rejected with a 401.',
  });

  const isLocal = /localhost|127\.0\.0\.1/i.test(config.appPublicUrl);
  checks.push({
    key: 'publicUrl',
    label: 'Public app URL',
    ok: !isLocal,
    detail: isLocal
      ? `APP_PUBLIC_URL is ${config.appPublicUrl} — Mailgun cannot reach that. Set it to this deployment's public URL.`
      : `Mailgun should forward replies to ${config.appPublicUrl}${expectedPath}.`,
  });

  const configured = isEmailConfigured(creds);
  checks.push({
    key: 'mailgun',
    label: 'Mailgun credentials',
    ok: configured,
    detail: configured
      ? `Using domain ${creds.domain}.`
      : 'Add a Mailgun API key and domain in Settings → Integrations first.',
  });

  if (!configured) {
    checks.push(
      { key: 'mx', label: 'Domain accepts inbound mail', ok: null, detail: 'Skipped — Mailgun is not configured.' },
      { key: 'route', label: 'Route forwards replies here', ok: null, detail: 'Skipped — Mailgun is not configured.' }
    );
    return { ok: false, webhookUrl, checks };
  }

  // MX records. A domain set up for sending only has SPF/DKIM but no MX, so
  // replies to it are never delivered to Mailgun at all — nothing downstream
  // can fix that.
  try {
    const domain = await mailgunGet(`/domains/${encodeURIComponent(creds.domain)}`, creds.apiKey);
    const receiving: any[] = domain?.receiving_dns_records || [];
    const isSandbox = String(domain?.domain?.type || '') === 'sandbox';
    const invalid = receiving.filter((r) => String(r?.valid).toLowerCase() !== 'valid');
    checks.push({
      key: 'mx',
      label: 'Domain accepts inbound mail',
      ok: receiving.length > 0 && invalid.length === 0,
      detail:
        receiving.length === 0
          ? `Mailgun reports no receiving (MX) records for ${creds.domain}. Replies to this domain never reach Mailgun.`
          : invalid.length === 0
            ? `MX records verified${isSandbox ? ' (sandbox domain — inbound works, outbound is limited to authorized recipients)' : ''}.`
            : `These receiving records are not verified yet: ${invalid
                .map((r) => `${r.record_type} ${r.value}`)
                .join(', ')}. Add them at your DNS host.`,
    });
  } catch (err) {
    checks.push({
      key: 'mx',
      label: 'Domain accepts inbound mail',
      ok: null,
      detail: `Could not read the domain from Mailgun: ${err instanceof Error ? err.message : 'unknown error'}`,
    });
  }

  // The route itself: does anything actually forward mail to this deployment,
  // and is it carrying the right secret?
  try {
    const routes = await mailgunGet('/routes?limit=1000', creds.apiKey);
    const items: any[] = routes?.items || [];
    const targets = items.flatMap((r) =>
      forwardTargets(r?.actions).map((url) => ({ url, expression: String(r?.expression || '') }))
    );
    const ours = targets.filter((t) => t.url.includes(expectedPath));
    const match = ours.find((t) => {
      try {
        const parsed = new URL(t.url);
        return (
          routeCoversDomain(t.expression, creds.domain) &&
          parsed.pathname === expectedPath &&
          parsed.origin === new URL(config.appPublicUrl).origin &&
          parsed.searchParams.get('secret') === secret
        );
      } catch {
        return false;
      }
    });

    checks.push({
      key: 'route',
      label: 'Route forwards replies here',
      ok: !!match,
      detail: match
        ? `Route matched: ${match.expression || '(no expression)'} → forwards here with the right secret.`
        : ours.length > 0
          ? `A route points at ${expectedPath} but its domain scope, path, host or secret does not match this deployment: ${ours
              .map((t) => t.url.replace(/secret=[^&]*/i, 'secret=***'))
              .join(', ')}`
          : `No Mailgun route forwards to ${expectedPath}. Create one in Mailgun → Receiving → Routes: expression match_recipient(".*@${creds.domain}"), action forward("${config.appPublicUrl}${expectedPath}?secret=YOUR_INBOUND_WEBHOOK_SECRET").`,
    });
  } catch (err) {
    checks.push({
      key: 'route',
      label: 'Route forwards replies here',
      ok: null,
      detail: `Could not list Mailgun routes: ${err instanceof Error ? err.message : 'unknown error'}`,
    });
  }

  return { ok: checks.every((c) => c.ok === true), webhookUrl, checks };
}

/** Recognize domain-wide routing without executing arbitrary provider regexes. */
export function routeCoversDomain(expression: string, domain: string): boolean {
  if (expression.trim() === 'catch_all()') return true;
  const match = expression.trim().match(/^match_recipient\(["'](.+)["']\)$/);
  if (!match) return false;
  const pattern = match[1].replace(/^\^/, '').replace(/\$$/, '');
  return [`.*@${domain}`, `.*@${domain.replace(/\./g, '\\.')}`].includes(pattern);
}
