import { randomUUID } from 'crypto';
import { BrowserSession } from '../engine/browser/browser.service';
import {
  PLATFORM_LOGIN_URLS,
  PlatformKey,
  probeLoggedOut,
  upsertAccount,
} from './social-account.service';

/**
 * Interactive ("Operator-style") social login. Instead of capturing a session
 * on the user's machine and replaying it from the server — which platforms
 * flag because the IP and browser fingerprint change — we open the login page
 * in the SERVER's own headless browser and stream screenshots to the UI. The
 * user clicks and types through the stream (2FA included). The resulting
 * session is born on the same IP + user agent every agent run uses, which is
 * what makes it survive instead of expiring within days.
 *
 * In-memory by design, like the live-view registry: the API and worker share
 * one process, and a login session is short-lived (minutes).
 */

export interface InteractiveLoginFrame {
  id: string;
  platform: PlatformKey;
  url: string;
  /** JPEG as base64 (no data: prefix). */
  imageBase64: string;
  /** Viewport the screenshot was taken at — the UI maps clicks back to this. */
  viewport: { width: number; height: number };
}

interface LoginEntry {
  organizationId: string;
  platform: PlatformKey;
  label: string;
  session: BrowserSession;
  lastActivityAt: number;
  /** Serializes actions on one browser — concurrent clicks corrupt state. */
  queue: Promise<unknown>;
}

const VIEWPORT = { width: 1280, height: 900 };
const IDLE_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS_PER_ORG = 2;

const entries = new Map<string, LoginEntry>();

async function pruneIdle(): Promise<void> {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, entry] of entries) {
    if (entry.lastActivityAt < cutoff) {
      entries.delete(id);
      await entry.session.close().catch(() => undefined);
    }
  }
}

function getEntry(id: string, organizationId: string): LoginEntry {
  const entry = entries.get(id);
  if (!entry || entry.organizationId !== organizationId) {
    throw new Error('Login session not found or expired — start again.');
  }
  entry.lastActivityAt = Date.now();
  return entry;
}

/** Run an action on the entry's browser, serialized behind prior actions. */
function enqueue<T>(entry: LoginEntry, fn: () => Promise<T>): Promise<T> {
  const next = entry.queue.then(fn, fn);
  entry.queue = next.catch(() => undefined);
  return next;
}

async function captureFrame(id: string, entry: LoginEntry): Promise<InteractiveLoginFrame> {
  return {
    id,
    platform: entry.platform,
    url: entry.session.currentUrl(),
    imageBase64: await entry.session.screenshotBase64(),
    viewport: VIEWPORT,
  };
}

/** Open the platform's login page in a fresh server-side browser. */
export async function startInteractiveLogin(
  organizationId: string,
  platform: PlatformKey,
  label = 'default'
): Promise<InteractiveLoginFrame> {
  await pruneIdle();

  const orgSessions = [...entries.values()].filter((e) => e.organizationId === organizationId);
  if (orgSessions.length >= MAX_SESSIONS_PER_ORG) {
    throw new Error('Too many login windows open — finish or cancel one first.');
  }

  const session = new BrowserSession();
  await session.open();
  const id = randomUUID();
  const entry: LoginEntry = {
    organizationId,
    platform,
    label,
    session,
    lastActivityAt: Date.now(),
    queue: Promise.resolve(),
  };
  entries.set(id, entry);

  try {
    await session.goto(PLATFORM_LOGIN_URLS[platform]);
  } catch {
    // Some platforms stall past domcontentloaded; the frame will still show
    // whatever rendered, and the user can retry from the UI.
  }
  return captureFrame(id, entry);
}

/** Latest screenshot + URL for the UI's polling loop. */
export async function getInteractiveFrame(
  id: string,
  organizationId: string
): Promise<InteractiveLoginFrame> {
  const entry = getEntry(id, organizationId);
  return enqueue(entry, () => captureFrame(id, entry));
}

export type InteractiveInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; deltaY: number };

// Keys the UI is allowed to forward — enough for any login form.
const ALLOWED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown']);

/** Forward one user input into the browser and return the resulting frame. */
export async function sendInteractiveInput(
  id: string,
  organizationId: string,
  input: InteractiveInput
): Promise<InteractiveLoginFrame> {
  const entry = getEntry(id, organizationId);
  return enqueue(entry, async () => {
    if (input.type === 'click') {
      const x = Math.min(Math.max(0, Number(input.x) || 0), VIEWPORT.width);
      const y = Math.min(Math.max(0, Number(input.y) || 0), VIEWPORT.height);
      await entry.session.clickAt(x, y);
    } else if (input.type === 'type') {
      const text = String(input.text ?? '').slice(0, 500);
      if (text) await entry.session.typeText(text);
    } else if (input.type === 'press') {
      if (!ALLOWED_KEYS.has(input.key)) throw new Error(`Key not allowed: ${input.key}`);
      await entry.session.pressKey(input.key);
    } else if (input.type === 'scroll') {
      const dy = Math.min(Math.max(-2000, Number(input.deltaY) || 0), 2000);
      if (dy) await entry.session.scrollBy(dy);
    } else {
      throw new Error('Unknown input type');
    }
    return captureFrame(id, entry);
  });
}

/**
 * Finish the flow: confirm the login took, save the session (encrypted) as the
 * org's account for this platform, and close the browser. Returns whether the
 * login was live; when it isn't, the browser stays open so the user can keep
 * going (e.g. a missed 2FA step).
 */
export async function completeInteractiveLogin(
  id: string,
  organizationId: string
): Promise<{ connected: boolean; accountId?: string; frame?: InteractiveLoginFrame }> {
  const entry = getEntry(id, organizationId);
  return enqueue(entry, async () => {
    const loggedOut = await probeLoggedOut(entry.session, entry.platform);
    if (loggedOut) {
      return { connected: false, frame: await captureFrame(id, entry) };
    }
    const state = await entry.session.exportState();
    const account = await upsertAccount({
      organizationId,
      platform: entry.platform,
      label: entry.label,
      storageState: state,
    });
    entries.delete(id);
    await entry.session.close().catch(() => undefined);
    return { connected: true, accountId: account.id };
  });
}

/** Abandon the flow and close the browser. */
export async function cancelInteractiveLogin(id: string, organizationId: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry || entry.organizationId !== organizationId) return;
  entries.delete(id);
  await entry.session.close().catch(() => undefined);
}
