import { prisma } from '../config/database';
import { decrypt, encrypt } from '../utils/encryption';
import { BrowserSession } from '../engine/browser/browser.service';

export type PlatformKey = 'linkedin' | 'facebook' | 'instagram' | 'x';

const PLATFORM_ENUM: Record<PlatformKey, 'LINKEDIN' | 'FACEBOOK' | 'INSTAGRAM' | 'X'> = {
  linkedin: 'LINKEDIN',
  facebook: 'FACEBOOK',
  instagram: 'INSTAGRAM',
  x: 'X',
};

/**
 * Home URL + signals that appear only on a login wall. `url` is matched against
 * the FINAL url (a redirect to /login is the reliable logged-out signal). `text`
 * is an optional match against page body for sites that render a login splash at
 * the same url without redirecting (Facebook). Text patterns are kept tight — a
 * bare "login" matches all over a logged-IN page and produces false "expired".
 */
const PLATFORM_PROBE: Record<PlatformKey, { url: string; loggedOutUrl: RegExp; loggedOutText?: RegExp }> = {
  linkedin: { url: 'https://www.linkedin.com/feed/', loggedOutUrl: /\/(login|uas\/login|checkpoint|authwall)/i },
  facebook: {
    url: 'https://www.facebook.com/',
    loggedOutUrl: /login\.php|\/checkpoint|\/login\//i,
    loggedOutText: /log in to facebook|log into facebook|create new account/i,
  },
  instagram: {
    url: 'https://www.instagram.com/',
    loggedOutUrl: /\/accounts\/login/i,
    loggedOutText: /log in to instagram|sign up to see/i,
  },
  x: { url: 'https://x.com/home', loggedOutUrl: /\/(login|i\/flow\/login)/i },
};

export function toPlatformEnum(platform: PlatformKey) {
  return PLATFORM_ENUM[platform];
}

/** Load a connected session's storageState object for the browser to reuse. */
export async function loadStorageState(
  organizationId: string,
  platform: PlatformKey,
  label = 'default'
): Promise<Record<string, unknown> | null> {
  const account = await prisma.socialAccount.findUnique({
    where: {
      organizationId_platform_label: {
        organizationId,
        platform: PLATFORM_ENUM[platform],
        label,
      },
    },
  });
  if (!account || account.status === 'EXPIRED') return null;
  try {
    return JSON.parse(decrypt(account.encryptedState));
  } catch {
    return null;
  }
}

/**
 * Persist a refreshed storageState back after a browser run. Platforms rotate
 * cookies on use, so saving after each run keeps the login alive for weeks —
 * this is what makes it "log in once, stay logged in".
 */
export async function saveStorageState(
  organizationId: string,
  platform: PlatformKey,
  state: Record<string, unknown>,
  label = 'default'
): Promise<void> {
  await prisma.socialAccount.updateMany({
    where: { organizationId, platform: PLATFORM_ENUM[platform], label },
    data: { encryptedState: encrypt(JSON.stringify(state)), lastUsedAt: new Date() },
  });
}

/** Upsert a captured session (from the login-capture helper or an upload). */
export async function upsertAccount(input: {
  organizationId: string;
  platform: PlatformKey;
  label?: string;
  storageState: Record<string, unknown>;
}) {
  const label = input.label || 'default';
  return prisma.socialAccount.upsert({
    where: {
      organizationId_platform_label: {
        organizationId: input.organizationId,
        platform: PLATFORM_ENUM[input.platform],
        label,
      },
    },
    create: {
      organizationId: input.organizationId,
      platform: PLATFORM_ENUM[input.platform],
      label,
      encryptedState: encrypt(JSON.stringify(input.storageState)),
      status: 'CONNECTED',
    },
    update: {
      encryptedState: encrypt(JSON.stringify(input.storageState)),
      status: 'CONNECTED',
    },
  });
}

/**
 * Why a session check failed. "Expired" was previously reported for every
 * failure, which is actively misleading: a security checkpoint and a dead
 * cookie need opposite responses (approve the login vs. re-capture it), and
 * telling someone to re-capture when Facebook is challenging the login sends
 * them round a loop that can never succeed.
 */
export type ValidationReason =
  | 'ok'
  | 'checkpoint' // platform is challenging the login (new device/IP)
  | 'login_wall' // genuinely not authenticated — cookies missing or dead
  | 'unreadable_state' // stored blob won't decrypt/parse
  | 'browser_error'; // couldn't even complete the probe

export interface ValidationResult {
  live: boolean;
  reason: ValidationReason;
  /** Operator-facing next step. */
  detail: string;
  /** Where the probe actually landed — the evidence behind the verdict. */
  finalUrl?: string;
}

/**
 * Open the platform with the stored session and check whether we're still
 * logged in, updating the account status and reporting WHY when it isn't.
 */
export async function validateAccount(
  accountId: string,
  organizationId: string
): Promise<ValidationResult> {
  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, organizationId },
  });
  if (!account) {
    return { live: false, reason: 'browser_error', detail: 'Account not found.' };
  }

  const platform = (Object.keys(PLATFORM_ENUM) as PlatformKey[]).find(
    (k) => PLATFORM_ENUM[k] === account.platform
  )!;
  const probe = PLATFORM_PROBE[platform];

  const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(decrypt(account.encryptedState));
  } catch {
    await prisma.socialAccount.update({ where: { id: account.id }, data: { status: 'ERROR' } });
    return {
      live: false,
      reason: 'unreadable_state',
      detail:
        'The stored session could not be read. If the server encryption key changed since it was saved, reconnect the account to store it again.',
    };
  }

  // A quick shape check catches the most common paste mistake before we spend a
  // browser launch on it: pasting a fragment of session.json, or the wrong file.
  const cookieCount = Array.isArray((state as { cookies?: unknown[] }).cookies)
    ? (state as { cookies: unknown[] }).cookies.length
    : 0;
  if (cookieCount === 0) {
    await prisma.socialAccount.update({ where: { id: account.id }, data: { status: 'EXPIRED' } });
    return {
      live: false,
      reason: 'login_wall',
      detail:
        'The saved session contains no cookies, so it was never a logged-in session. Re-run the capture command, make sure you are fully logged in before closing the browser window, and paste the whole file.',
    };
  }

  const session = new BrowserSession();
  try {
    await session.open({ storageState: state });
    const obs = await session.goto(probe.url);

    // A checkpoint is NOT an expired cookie — the platform recognises the
    // session and is challenging it, typically because it was captured on your
    // machine and is now being replayed from the server.
    const challenged = /\/checkpoint|\/challenge|two_step_verification|login_approval/i.test(obs.url);
    const loggedOut =
      probe.loggedOutUrl.test(obs.url) ||
      (!!probe.loggedOutText && probe.loggedOutText.test(obs.text));

    // Refresh cookies while we're here to extend the session.
    const refreshed = await session.exportState();
    await session.close();

    const live = !loggedOut && !challenged;
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        status: live ? 'CONNECTED' : 'EXPIRED',
        lastValidatedAt: new Date(),
        ...(live ? { encryptedState: encrypt(JSON.stringify(refreshed)) } : {}),
      },
    });

    if (live) {
      return { live: true, reason: 'ok', detail: 'Session is live.', finalUrl: obs.url };
    }
    if (challenged) {
      return {
        live: false,
        reason: 'checkpoint',
        finalUrl: obs.url,
        detail: `${platformLabel} is challenging this login with a security checkpoint rather than rejecting it — it usually does this the first time a session is used from somewhere new, which is exactly what happens when a session captured on your computer is replayed from the server. Re-capturing will NOT fix it. Open ${platformLabel} on your own device, approve the login attempt (look for a recent unrecognised-login alert, or Settings → Security → Where you're logged in), then test again.`,
      };
    }
    return {
      live: false,
      reason: 'login_wall',
      finalUrl: obs.url,
      detail: `${platformLabel} served a login page, so the session is not authenticating. Re-capture it, and before closing the capture browser confirm you can actually see your feed — closing at the login screen saves a logged-out session.`,
    };
  } catch (err) {
    await session.close().catch(() => undefined);
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { status: 'ERROR', lastValidatedAt: new Date() },
    });
    return {
      live: false,
      reason: 'browser_error',
      detail: `The check could not run: ${err instanceof Error ? err.message : 'browser failed to start'}. This is a problem on our side, not with your session.`,
    };
  }
}
