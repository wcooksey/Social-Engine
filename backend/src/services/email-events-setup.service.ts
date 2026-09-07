import { config } from '../config/environment';
import { MAILGUN_API } from './channels.service';

const EVENTS = ['delivered', 'permanent_fail', 'temporary_fail', 'complained'] as const;
export interface EventSetupCheck { domain: string; event: string; ok: boolean; detail: string }

/** No sends or synthetic events. Only the existing app endpoint can be connected. */
export async function setupDomainEvents(domain: string, apiKey: string, connect = false): Promise<EventSetupCheck[]> {
  const app = new URL(config.appPublicUrl);
  if (app.protocol !== 'https:' || !config.inbound.webhookSecret) throw new Error('HTTPS public app URL and inbound secret are required.');
  const target = new URL('/api/webhooks/inbound/mailgun-events', app);
  target.searchParams.set('secret', config.inbound.webhookSecret);
  const path = `${MAILGUN_API}/domains/${encodeURIComponent(domain)}/webhooks`;
  const headers = { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` };
  const request = async (url: string, init: RequestInit = {}) => {
    const result = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(12000) });
    // Provider errors can echo a URL containing the secret. Never expose them.
    if (!result.ok) throw new Error(`Mailgun webhook request returned HTTP ${result.status}.`);
    return result.json() as Promise<any>;
  };
  const matches = (url: string) => {
    try { const parsed = new URL(url); return parsed.origin === target.origin && parsed.pathname === target.pathname && parsed.searchParams.get('secret') === config.inbound.webhookSecret; } catch { return false; }
  };
  const initial = await request(path);
  const checks: EventSetupCheck[] = [];
  for (const event of EVENTS) {
    const existing = initial.webhooks?.[event];
    if (existing && !Array.isArray(existing.urls)) throw new Error('Unexpected webhook response; existing configuration was preserved.');
    const urls: string[] = Array.isArray(existing?.urls) ? existing.urls : [];
    if (!urls.some(matches) && connect) {
      if (urls.length >= 3) {
        checks.push({ domain, event, ok: false, detail: 'All three webhook slots are occupied. Existing destinations were preserved; review them in Mailgun.' });
        continue;
      }
      const body = new FormData();
      if (!existing) body.append('id', event);
      for (const url of [...urls, target.toString()]) body.append('url', url);
      try {
        await request(existing ? `${path}/${event}` : path, { method: existing ? 'PUT' : 'POST', body });
        const verified = await request(`${path}/${event}`);
        const ok = Array.isArray(verified.webhook?.urls) && verified.webhook.urls.some(matches);
        checks.push({ domain, event, ok, detail: ok ? 'Connected to this app and verified with Mailgun. Actual event receipt still needs a real delivery.' : 'Provider did not confirm this app destination.' });
      } catch (error) {
        checks.push({ domain, event, ok: false, detail: error instanceof Error ? error.message : 'Could not connect event reporting.' });
      }
    } else {
      const ok = urls.some(matches);
      checks.push({ domain, event, ok, detail: ok ? 'This app destination is configured. Configuration does not prove event receipt.' : 'This app is not configured as a domain-level destination for this event.' });
    }
  }
  return checks;
}
