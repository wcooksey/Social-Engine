import { config } from '../config/environment';
import { assertPublicUrl } from '../utils/url-guard';

/**
 * Web research channel for the Engine. Phase 1 wires a real search provider;
 * fetch_page works today via plain HTTP + readable-text extraction.
 */
export interface SearchCreds {
  apiKey: string;
  provider: string;
}

class ResearchService {
  async searchWeb(
    query: string,
    count = 10,
    creds?: SearchCreds
  ): Promise<{ results: unknown[]; note?: string }> {
    const apiKey = creds?.apiKey || config.search.apiKey;
    const provider = creds?.provider || config.search.provider;
    if (!apiKey) {
      return {
        results: [],
        note: 'No search API key configured. Ask the user to add a search provider key in Settings > Integrations, or research via fetch_page on known URLs.',
      };
    }

    if (provider === 'brave') {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;
      const res = await fetch(url, {
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      });
      if (!res.ok) {
        return { results: [], note: `Search API error: ${res.status} ${res.statusText}` };
      }
      const body = (await res.json()) as {
        web?: { results?: { title: string; url: string; description: string }[] };
      };
      return {
        results: (body.web?.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
        })),
      };
    }

    return { results: [], note: `Unsupported search provider: ${provider}` };
  }

  async fetchPage(url: string): Promise<{ url: string; text?: string; error?: string }> {
    try {
      // SSRF guard: the target is agent-chosen (and thus influenceable by web
      // content). Validate every hop of a redirect chain, not just the first.
      let current = (await assertPublicUrl(url)).toString();
      let res: Response | null = null;
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Neuralnetics/0.1)',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) break;
          current = (await assertPublicUrl(new URL(location, current).toString())).toString();
          continue;
        }
        break;
      }
      if (!res) return { url, error: 'Fetch failed' };
      if (!res.ok) return { url, error: `HTTP ${res.status} ${res.statusText}` };

      const html = await res.text();
      return { url, ...distillPage(html) };
    } catch (err) {
      return { url, error: err instanceof Error ? err.message : 'Fetch failed' };
    }
  }
}

/**
 * How much page text an agent gets back.
 *
 * This was 20,000 characters — roughly 5,000 tokens of one webpage, most of it
 * navigation, cookie banners and footer boilerplate. A research run that reads
 * twenty sites carried a hundred thousand tokens of that, and the two facts
 * that mattered sat in the middle, which is exactly where a model attends
 * worst. Cutting it is not about cost; it is about not burying the answer.
 */
const PAGE_TEXT_LIMIT = 6000;

const PAGE_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Template junk, asset filenames, and no-reply boxes — the last of these are
// real addresses but reach nobody, so listing them as findings is noise.
const PAGE_EMAIL_JUNK =
  /(example\.|sentry\.|wixpress|\.png|\.jpg|\.gif|\.webp|\.svg|@2x|noreply|no-reply|donotreply)/i;
const TEL_LINK_RE = /href=["']tel:([^"']+)["']/gi;
/** "Dana Reeves, General Manager" / "Dana Reeves - Sales Manager". */
const PERSON_TITLE_RE =
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'`-]+){1,2})\s*[,–—-]\s*((?:General|Sales|Service|Finance|Internet|Marketing|Operations|Parts|Fixed[- ]Ops)?\s*(?:Manager|Director|Principal|Owner|President|Partner|Founder|Officer|Lead|Head)[A-Za-z ]{0,24})/g;

export interface PageDistillate {
  /** Readable text, capped. Still the raw material when the agent needs it. */
  text: string;
  /** True when the page was longer than the cap. */
  truncated?: boolean;
  /** The high-signal items, pulled out so they can't be lost in the middle. */
  found?: {
    emails?: string[];
    phones?: string[];
    people?: string[];
  };
}

/**
 * Turn a page into findings plus a bounded excerpt.
 *
 * The extracted lists are the point: the agent gets the contact details as a
 * short, unmissable list instead of having to spot them inside thousands of
 * words of marketing copy.
 */
export function distillPage(html: string): PageDistillate {
  const full = extractReadableText(html);
  const text = full.slice(0, PAGE_TEXT_LIMIT);

  const emails = [
    ...new Set(
      (html.match(PAGE_EMAIL_RE) || [])
        .map((e) => e.toLowerCase())
        .filter((e) => !PAGE_EMAIL_JUNK.test(e))
    ),
  ].slice(0, 15);

  const phones = [
    ...new Set(
      [...html.matchAll(TEL_LINK_RE)]
        .map((m) => m[1].replace(/[^\d+]/g, ''))
        .filter((p) => p.replace(/\D/g, '').length >= 10)
    ),
  ].slice(0, 10);

  const people = [
    ...new Set(
      [...full.matchAll(PERSON_TITLE_RE)].map((m) => `${m[1]} — ${m[2].trim()}`)
    ),
  ].slice(0, 20);

  const found: PageDistillate['found'] = {};
  if (emails.length) found.emails = emails;
  if (phones.length) found.phones = phones;
  if (people.length) found.people = people;

  return {
    text,
    ...(full.length > PAGE_TEXT_LIMIT ? { truncated: true } : {}),
    ...(Object.keys(found).length ? { found } : {}),
  };
}

/** Crude but dependency-free HTML → readable text extraction. */
export function extractReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export const researchService = new ResearchService();
