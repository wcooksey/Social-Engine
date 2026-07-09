import { config } from '../config/environment';

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
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { url, error: 'Only http/https URLs are supported' };
      }
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SocialEngine/0.1; +https://social-engine.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!res.ok) return { url, error: `HTTP ${res.status} ${res.statusText}` };

      const html = await res.text();
      return { url, text: extractReadableText(html).slice(0, 20000) };
    } catch (err) {
      return { url, error: err instanceof Error ? err.message : 'Fetch failed' };
    }
  }
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
