import { assertPublicUrl } from '../utils/url-guard';

/**
 * Contact enrichment: turn a business (name + website) into reachable people.
 * Three complementary strategies, because no single source is reliable:
 *  - crawlSiteForContacts: deterministic crawl of the lead's own website
 *    (contact/about/team/staff pages) — emails found here are usually LIVE
 *    since the business publishes them.
 *  - apolloPeopleSearch: Apollo.io people search by company domain + titles —
 *    wide coverage, but emails can be stale; verify before trusting.
 *  - verifyEmail: Mailgun's address validation — screens dead mailboxes
 *    BEFORE a send can bounce and hurt deliverability.
 */

// ---------------------------------------------------------------------------
// Website crawl
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Junk emails frequently embedded in site templates/assets.
const EMAIL_JUNK = /(example\.|sentry\.|wixpress|\.png|\.jpg|\.gif|\.webp|\.svg|noreply|no-reply|donotreply|@2x)/i;
const CONTACT_LINK_RE = /(contact|about|team|staff|meet|people|leadership|management|our-story)/i;

async function fetchRawHtml(url: string): Promise<string | null> {
  try {
    let current = (await assertPublicUrl(url)).toString();
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SocialEngine/0.1; +https://social-engine.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        current = (await assertPublicUrl(new URL(location, current).toString())).toString();
        continue;
      }
      if (!res.ok) return null;
      return await res.text();
    }
    return null;
  } catch {
    return null;
  }
}

export interface CrawledContacts {
  emails: { email: string; foundOn: string }[];
  phones: string[];
  pagesCrawled: string[];
}

export async function crawlSiteForContacts(websiteUrl: string): Promise<CrawledContacts> {
  const result: CrawledContacts = { emails: [], phones: [], pagesCrawled: [] };
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  let base: URL;
  try {
    base = new URL(/^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`);
  } catch {
    return result;
  }

  const harvest = (html: string, pageUrl: string) => {
    for (const raw of html.match(EMAIL_RE) || []) {
      const email = raw.toLowerCase();
      if (EMAIL_JUNK.test(email) || seenEmails.has(email)) continue;
      seenEmails.add(email);
      result.emails.push({ email, foundOn: pageUrl });
    }
    // tel: links are the most reliable phone signal on business sites.
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      const phone = m[1].replace(/[^\d+]/g, '');
      if (phone.length >= 10 && !seenPhones.has(phone)) {
        seenPhones.add(phone);
        result.phones.push(phone);
      }
    }
  };

  const home = await fetchRawHtml(base.toString());
  if (!home) return result;
  result.pagesCrawled.push(base.toString());
  harvest(home, base.toString());

  // Follow up to 4 same-site links that look like contact/about/team pages.
  const candidates = new Set<string>();
  for (const m of home.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = m[1];
    if (!CONTACT_LINK_RE.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (url.hostname === base.hostname) candidates.add(url.toString());
    } catch {
      /* bad href */
    }
    if (candidates.size >= 4) break;
  }
  for (const url of candidates) {
    const html = await fetchRawHtml(url);
    if (!html) continue;
    result.pagesCrawled.push(url);
    harvest(html, url);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Apollo people search
// ---------------------------------------------------------------------------

export interface ApolloPerson {
  name: string;
  title?: string;
  email?: string;
  emailLocked: boolean;
  linkedinUrl?: string;
}

export async function apolloPeopleSearch(
  domain: string,
  titles: string[],
  apiKey: string,
  limit = 10
): Promise<{ people: ApolloPerson[]; error?: string }> {
  try {
    const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        ...(titles.length ? { person_titles: titles } : {}),
        page: 1,
        per_page: Math.min(limit, 25),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { people: [], error: `Apollo ${res.status}: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as {
      people?: {
        name?: string;
        first_name?: string;
        last_name?: string;
        title?: string;
        email?: string;
        linkedin_url?: string;
      }[];
    };
    const people = (body.people || []).map((p) => {
      const email = p.email || undefined;
      const locked = !email || email.includes('email_not_unlocked');
      return {
        name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        title: p.title,
        email: locked ? undefined : email,
        emailLocked: locked,
        linkedinUrl: p.linkedin_url,
      };
    });
    return { people };
  } catch (err) {
    return { people: [], error: err instanceof Error ? err.message : 'Apollo request failed' };
  }
}

// ---------------------------------------------------------------------------
// Email verification (Mailgun v4 validation)
// ---------------------------------------------------------------------------

export type EmailVerdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export async function verifyEmail(
  email: string,
  mailgunApiKey: string
): Promise<{ verdict: EmailVerdict; detail?: string }> {
  try {
    const res = await fetch(
      `https://api.mailgun.net/v4/address/validate?address=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { verdict: 'unknown', detail: `Mailgun validation ${res.status}: ${text.slice(0, 150)}` };
    }
    const body = (await res.json()) as { result?: string; risk?: string };
    const result = (body.result || '').toLowerCase();
    if (result === 'deliverable') return { verdict: 'deliverable' };
    if (result === 'undeliverable' || result === 'do_not_send') {
      return { verdict: 'undeliverable', detail: body.result };
    }
    if (result === 'catch_all' || body.risk === 'high' || body.risk === 'medium') {
      return { verdict: 'risky', detail: `${body.result || ''} risk=${body.risk || ''}`.trim() };
    }
    return { verdict: 'unknown', detail: body.result };
  } catch (err) {
    return { verdict: 'unknown', detail: err instanceof Error ? err.message : 'validation failed' };
  }
}
