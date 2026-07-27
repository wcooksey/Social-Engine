import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { config } from '../../config/environment';
import { isForbiddenUrlSync } from '../../utils/url-guard';
import { BlockSignal, detectBlock } from './block-detector';

/**
 * A controlled browser session for the browser-use agent. Wraps Playwright
 * (driving the pre-installed Chromium) and exposes a small, LLM-friendly
 * action surface: navigate, observe the page as a numbered list of interactive
 * elements + readable text, click/type by index, and screenshot.
 *
 * Optional persistent auth: point BROWSER_STORAGE_STATE at a Playwright
 * storageState JSON (cookies/localStorage) so the agent is logged in to the
 * social platforms you use — never hardcode credentials.
 */

export interface InteractiveElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  attributes: { href?: string; placeholder?: string; name?: string; ariaLabel?: string };
}

export interface PageObservation {
  url: string;
  title: string;
  text: string; // readable text, truncated
  elements: InteractiveElement[];
  /** Set when the platform is showing a block/checkpoint/captcha on this page. */
  block?: BlockSignal | null;
}

export interface OpenOptions {
  storageState?: Record<string, unknown> | string;
  /**
   * Per-account egress proxy (overrides the ambient HTTPS_PROXY). Social
   * accounts must keep a stable IP: an account that appears from a new
   * datacenter address every run gets checkpointed fast.
   */
  proxyUrl?: string;
}

/**
 * Find a Chromium/Chrome binary to launch, in priority order: an explicit
 * PLAYWRIGHT_CHROMIUM_PATH, well-known install locations, anything named
 * chromium/chrome on PATH (covers the Nix-provided chromium on Railway), and
 * finally Playwright's own downloaded browser. Returns undefined only when
 * nothing exists — the caller turns that into an actionable error instead of
 * Playwright's opaque "executable doesn't exist" launch failure.
 */
function resolveChromiumExecutable(chromium: {
  executablePath: () => string;
}): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;

  const wellKnown = [
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of wellKnown) if (existsSync(p)) return p;

  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }

  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    /* no bundled browser */
  }
  return undefined;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async open(opts?: OpenOptions): Promise<void> {
    const { chromium } = await import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) {
      throw new Error(
        'No Chromium browser is installed on this server, so browser tasks (web research, social DMs) cannot run. ' +
          'Fix the deployment: add "chromium" to nixPkgs in nixpacks.toml (Railway/Nixpacks), or run ' +
          '"npx playwright install chromium", or set PLAYWRIGHT_CHROMIUM_PATH to an existing Chrome/Chromium binary.'
      );
    }
    // A per-account proxy wins over the ambient one: social sessions need a
    // stable, account-pinned egress IP, while ordinary research can share the
    // app's proxy.
    const proxyUrl =
      opts?.proxyUrl ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY;
    // Playwright wants a comma-separated bypass list; honor NO_PROXY plus
    // localhost so internal requests don't tunnel through the egress proxy.
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    const bypass = ['localhost', '127.0.0.1', '::1', ...noProxy.split(',')]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    this.browser = await chromium.launch({
      executablePath,
      headless: config.browser.headless,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Removes the navigator.webdriver giveaway. Not full stealth, but this
        // flag is the single cheapest automation tell to drop.
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass } } : {}),
    });
    // Priority: a session object passed in (per-org social login) > a file
    // path from config > no stored session.
    const storageState =
      (opts?.storageState as never) || config.browser.storageStatePath || undefined;
    // Claim the version we are actually running. A UA pinned to an old Chrome
    // while the binary reports a newer one is itself a fingerprint mismatch —
    // the exact kind of inconsistency bot detection looks for.
    const major = (this.browser.version().match(/^(\d+)/) || [, '120'])[1];
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent:
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${major}.0.0.0 Safari/537.36`,
      locale: 'en-US',
      timezoneId: config.browser.timezone,
      ...(storageState ? { storageState } : {}),
    });
    // Belt-and-braces alongside the launch flag: some detection reads the
    // property directly rather than trusting the flag's absence.
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    // SSRF guard: navigation targets are agent-chosen (and influenceable by
    // page content), so block requests to loopback/link-local/private hosts —
    // including redirects and subresource loads — at the network layer.
    await this.context.route('**/*', (route) => {
      if (isForbiddenUrlSync(route.request().url())) {
        void route.abort('blockedbyclient');
        return;
      }
      void route.continue();
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser session not open');
    return this.page;
  }

  /**
   * Wait for the page to stop moving. Social platforms are slow SPAs: a fixed
   * sleep either wastes time or — far worse — hands the agent a half-rendered
   * page it then reasons about incorrectly. Network-idle with a floor and a
   * ceiling adapts to both.
   */
  private async settle(minMs = 400, maxMs = 8000): Promise<void> {
    const page = this.requirePage();
    await page.waitForTimeout(minMs);
    await page.waitForLoadState('networkidle', { timeout: maxMs }).catch(() => undefined);
  }

  async goto(url: string): Promise<PageObservation> {
    const page = this.requirePage();
    if (isForbiddenUrlSync(url)) {
      throw new Error('Blocked URL: internal/private addresses are not allowed');
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.settle();
    return this.observe();
  }

  async click(ref: number): Promise<PageObservation> {
    const handle = await this.elementByRef(ref);
    await handle.click({ timeout: 10000 }).catch(async () => {
      await handle.evaluate((el) => (el as HTMLElement).click());
    });
    await this.settle();
    return this.observe();
  }

  async type(ref: number, text: string, submit = false): Promise<PageObservation> {
    const page = this.requirePage();
    const handle = await this.elementByRef(ref);
    await handle.click({ timeout: 10000 });
    await handle.fill('').catch(() => undefined);
    // Human-ish cadence. Platforms sample inter-keystroke timing, and a
    // perfectly uniform 15ms rhythm is not something a person produces.
    for (const chunk of text.match(/.{1,3}/gs) || []) {
      await page.keyboard.type(chunk, { delay: 30 + Math.random() * 90 });
      if (Math.random() < 0.15) await page.waitForTimeout(120 + Math.random() * 400);
    }
    if (submit) {
      await page.waitForTimeout(300 + Math.random() * 700);
      await page.keyboard.press('Enter');
      await this.settle(800);
    } else {
      await this.settle(200);
    }
    return this.observe();
  }

  /** Scroll a container (or the window) and let lazy content load. */
  async scrollContainer(selector: string | null, times = 1): Promise<void> {
    const page = this.requirePage();
    for (let i = 0; i < times; i++) {
      if (selector) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = el.scrollHeight;
        }, selector);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
      await page.waitForTimeout(700 + Math.random() * 900);
    }
  }

  async screenshotBase64(): Promise<string> {
    const page = this.requirePage();
    // JPEG at modest quality: ~10x smaller than PNG, plenty for a live view.
    const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
    return buf.toString('base64');
  }

  /**
   * Resolve a ref stamped during the last observe().
   *
   * This is the difference between "click the 34th interactive element on the
   * page right now" and "click the element I actually showed the model". Between
   * an observation and the click, an SPA can insert a toast, finish a lazy load,
   * or open a modal — and a positional index then lands on a different control.
   * On a DM flow that means the wrong button or the wrong recipient. A stamped
   * ref either resolves to the exact node that was observed, or fails loudly and
   * tells the model to re-observe.
   */
  private async elementByRef(ref: number) {
    const page = this.requirePage();
    const handle = await page.$(`[${REF_ATTR}="${ref}"]`);
    if (!handle) {
      throw new Error(
        `Element [${ref}] is no longer on the page — it changed since the last observation. ` +
          `Re-read the CURRENT element list and use a ref from it.`
      );
    }
    return handle;
  }

  /** Snapshot the page as readable text + a numbered list of interactive elements. */
  async observe(): Promise<PageObservation> {
    const page = this.requirePage();
    const url = page.url();
    const title = await page.title().catch(() => '');

    // Stamp each interactive node with a stable ref, clearing the previous
    // round's stamps first so a stale node can never answer to a fresh ref.
    const elements = await page.evaluate(
      ({ selector, attr, max }) => {
        document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr));
        const out: {
          index: number;
          tag: string;
          role: string;
          text: string;
          attributes: Record<string, string | undefined>;
        }[] = [];
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, max);
        nodes.forEach((node, i) => {
          const el = node as HTMLElement;
          el.setAttribute(attr, String(i));
          out.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('value') || '').trim().slice(0, 120),
            attributes: {
              href: el.getAttribute('href') || undefined,
              placeholder: el.getAttribute('placeholder') || undefined,
              name: el.getAttribute('name') || undefined,
              ariaLabel: el.getAttribute('aria-label') || undefined,
            },
          });
        });
        return out;
      },
      { selector: INTERACTIVE_SELECTOR, attr: REF_ATTR, max: 120 }
    );

    const text = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return body.replace(/\n{3,}/g, '\n\n').slice(0, 6000);
    });

    return {
      url,
      title,
      text,
      elements: elements as InteractiveElement[],
      block: detectBlock(url, text),
    };
  }

  /**
   * Extract structured rows without an LLM in the loop. Used by the follower
   * harvester: walking a list of 500 profiles through observe() would be 500
   * model calls for work a selector does exactly.
   */
  async extractLinks(containerSelector: string | null, hrefPattern: RegExp): Promise<
    { href: string; text: string }[]
  > {
    const page = this.requirePage();
    const rows = await page.$$eval(
      containerSelector ? `${containerSelector} a[href]` : 'a[href]',
      (nodes) =>
        nodes.map((n) => ({
          href: (n as HTMLAnchorElement).href || '',
          text: ((n as HTMLElement).innerText || '').trim().slice(0, 200),
        }))
    );
    return rows.filter((r) => hrefPattern.test(r.href));
  }

  /** Current page URL (for callers that need it without a full observation). */
  currentUrl(): string {
    return this.page?.url() || '';
  }

  /** Export the current cookies + localStorage to persist the refreshed session. */
  async exportState(): Promise<Record<string, unknown>> {
    if (!this.context) return {};
    return (await this.context.storageState()) as unknown as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [contenteditable=true]';

/** Attribute stamped on observed nodes so later actions target the same element. */
const REF_ATTR = 'data-agent-ref';
