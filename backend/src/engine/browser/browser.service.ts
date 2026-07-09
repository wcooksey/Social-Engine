import type { Browser, BrowserContext, Page } from 'playwright';
import { config } from '../../config/environment';

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
}

const EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async open(opts?: { storageState?: Record<string, unknown> | string }): Promise<void> {
    const { chromium } = await import('playwright');
    // Honor the environment's HTTPS proxy so the browser reaches the internet
    // through the same egress path as the rest of the app.
    const proxyUrl =
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    // Playwright wants a comma-separated bypass list; honor NO_PROXY plus
    // localhost so internal requests don't tunnel through the egress proxy.
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    const bypass = ['localhost', '127.0.0.1', '::1', ...noProxy.split(',')]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    this.browser = await chromium.launch({
      executablePath: EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass } } : {}),
    });
    // Priority: a session object passed in (per-org social login) > a file
    // path from config > no stored session.
    const storageState =
      (opts?.storageState as never) || config.browser.storageStatePath || undefined;
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ...(storageState ? { storageState } : {}),
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('Browser session not open');
    return this.page;
  }

  async goto(url: string): Promise<PageObservation> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    return this.observe();
  }

  async click(index: number): Promise<PageObservation> {
    const page = this.requirePage();
    const handle = await this.elementByIndex(index);
    if (!handle) throw new Error(`No interactive element with index ${index}`);
    await handle.click({ timeout: 10000 }).catch(async () => {
      await handle.evaluate((el) => (el as HTMLElement).click());
    });
    await page.waitForTimeout(1200);
    return this.observe();
  }

  async type(index: number, text: string, submit = false): Promise<PageObservation> {
    const page = this.requirePage();
    const handle = await this.elementByIndex(index);
    if (!handle) throw new Error(`No interactive element with index ${index}`);
    await handle.click({ timeout: 10000 });
    await handle.fill('').catch(() => undefined);
    await page.keyboard.type(text, { delay: 15 });
    if (submit) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }
    return this.observe();
  }

  async screenshotBase64(): Promise<string> {
    const page = this.requirePage();
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    return buf.toString('base64');
  }

  private async elementByIndex(index: number) {
    const page = this.requirePage();
    const handles = await page.$$(INTERACTIVE_SELECTOR);
    return handles[index] ?? null;
  }

  /** Snapshot the page as readable text + a numbered list of interactive elements. */
  async observe(): Promise<PageObservation> {
    const page = this.requirePage();
    const url = page.url();
    const title = await page.title().catch(() => '');

    const elements = await page.$$eval(INTERACTIVE_SELECTOR, (nodes) =>
      nodes.slice(0, 120).map((node, i) => {
        const el = node as HTMLElement;
        const text = (el.innerText || el.getAttribute('value') || '').trim().slice(0, 120);
        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          text,
          attributes: {
            href: el.getAttribute('href') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            name: el.getAttribute('name') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
          },
        };
      })
    );

    const text = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return body.replace(/\n{3,}/g, '\n\n').slice(0, 6000);
    });

    return { url, title, text, elements };
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
