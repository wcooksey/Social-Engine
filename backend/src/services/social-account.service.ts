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

/** Home URL + a substring that only appears when logged OUT (login wall). */
const PLATFORM_PROBE: Record<PlatformKey, { url: string; loggedOutSignal: RegExp }> = {
  linkedin: { url: 'https://www.linkedin.com/feed/', loggedOutSignal: /\/(login|uas\/login|checkpoint)/i },
  facebook: { url: 'https://www.facebook.com/', loggedOutSignal: /login|log in to facebook/i },
  instagram: { url: 'https://www.instagram.com/', loggedOutSignal: /\/accounts\/login/i },
  x: { url: 'https://x.com/home', loggedOutSignal: /\/(login|i\/flow\/login)/i },
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
 * Open the platform with the stored session and check whether we're still
 * logged in. Updates the account status. Returns true if the login is live.
 */
export async function validateAccount(accountId: string, organizationId: string): Promise<boolean> {
  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, organizationId },
  });
  if (!account) return false;

  const platform = (Object.keys(PLATFORM_ENUM) as PlatformKey[]).find(
    (k) => PLATFORM_ENUM[k] === account.platform
  )!;
  const probe = PLATFORM_PROBE[platform];

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(decrypt(account.encryptedState));
  } catch {
    await prisma.socialAccount.update({ where: { id: account.id }, data: { status: 'ERROR' } });
    return false;
  }

  const session = new BrowserSession();
  try {
    await session.open({ storageState: state });
    const obs = await session.goto(probe.url);
    const loggedOut = probe.loggedOutSignal.test(obs.url) || probe.loggedOutSignal.test(obs.text);
    // Refresh cookies while we're here to extend the session.
    const refreshed = await session.exportState();
    await session.close();

    await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        status: loggedOut ? 'EXPIRED' : 'CONNECTED',
        lastValidatedAt: new Date(),
        ...(loggedOut ? {} : { encryptedState: encrypt(JSON.stringify(refreshed)) }),
      },
    });
    return !loggedOut;
  } catch {
    await session.close().catch(() => undefined);
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { status: 'ERROR', lastValidatedAt: new Date() },
    });
    return false;
  }
}
