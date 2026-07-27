import { prisma } from '../config/database';
import { notify } from '../services/notification.service';
import { BlockSignal, COOLDOWN_HOURS, describeBlock } from '../engine/browser/block-detector';
import { PlatformKey, toPlatformEnum } from './social-account.service';

/**
 * Per-account send limits for social outreach.
 *
 * These are deliberately not the org's `dailySendCap`: an email cap is about
 * the org's sender reputation, while a social cap is about one account's
 * standing with one platform. Cold DMs to non-followers are the throttled
 * category everywhere, and a newly connected account tolerates a small
 * fraction of what a warmed one does — so every account carries its own
 * ceiling, ramps into it, and is quarantined on the first sign of a block.
 *
 * Everything here is enforced deterministically. The AI never decides whether
 * it is allowed to send.
 */

export interface SendPermission {
  allowed: boolean;
  reason?: string;
  /** Effective caps after the warmup ramp, for logging and UI. */
  caps?: { daily: number; hourly: number; sentToday: number; sentThisHour: number };
  /** When a denial is temporary, when to try again. */
  retryAt?: Date;
}

/**
 * Warmup ramp. A fresh account opens at ~25% of its target and reaches full
 * allowance over `warmupDays`. Platforms model per-account behavioural
 * baselines, so a login that sends 20 DMs on day one looks nothing like the
 * account it is pretending to be.
 */
export function warmupFactor(warmupStartedAt: Date | null, warmupDays: number): number {
  if (!warmupStartedAt || warmupDays <= 0) return 1;
  const days = (Date.now() - warmupStartedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (days >= warmupDays) return 1;
  return 0.25 + 0.75 * (days / warmupDays);
}

function effectiveCaps(account: {
  dailyDmCap: number;
  hourlyDmCap: number;
  warmupDays: number;
  warmupStartedAt: Date | null;
}): { daily: number; hourly: number } {
  const f = warmupFactor(account.warmupStartedAt, account.warmupDays);
  return {
    daily: Math.max(1, Math.floor(account.dailyDmCap * f)),
    hourly: Math.max(1, Math.floor(account.hourlyDmCap * f)),
  };
}

/**
 * May this account send right now? Checks, in order: account health, an active
 * cooldown, the hourly cap, then the daily cap.
 */
export async function canSend(accountId: string): Promise<SendPermission> {
  const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) return { allowed: false, reason: 'Social account not found.' };

  if (account.status !== 'CONNECTED') {
    return {
      allowed: false,
      reason: `Account status is ${account.status} — reconnect it in Settings → Social accounts.`,
    };
  }

  if (account.cooldownUntil && account.cooldownUntil > new Date()) {
    return {
      allowed: false,
      reason:
        `Account is cooling down until ${account.cooldownUntil.toISOString()} ` +
        `after: ${account.lastBlockKind || 'a platform block'}.`,
      retryAt: account.cooldownUntil,
    };
  }

  const caps = effectiveCaps(account);
  const now = Date.now();
  const [sentThisHour, sentToday] = await Promise.all([
    prisma.socialSendLog.count({
      where: { accountId, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    }),
    prisma.socialSendLog.count({
      where: { accountId, createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } },
    }),
  ]);

  const stats = { ...caps, sentToday, sentThisHour };

  if (sentThisHour >= caps.hourly) {
    return {
      allowed: false,
      reason: `Hourly cap reached for this account (${sentThisHour}/${caps.hourly}).`,
      caps: stats,
      retryAt: new Date(now + 60 * 60 * 1000),
    };
  }
  if (sentToday >= caps.daily) {
    return {
      allowed: false,
      reason: `Daily cap reached for this account (${sentToday}/${caps.daily}).`,
      caps: stats,
      retryAt: new Date(now + 60 * 60 * 1000),
    };
  }
  return { allowed: true, caps: stats };
}

/** Record a send against the account's budget. Call once per actual send. */
export async function recordSend(input: {
  organizationId: string;
  accountId: string;
  platform: PlatformKey;
  targetType: 'lead' | 'prospect';
  targetId: string;
  succeeded: boolean;
}): Promise<void> {
  await prisma.socialSendLog.create({
    data: {
      organizationId: input.organizationId,
      accountId: input.accountId,
      platform: toPlatformEnum(input.platform),
      targetType: input.targetType,
      targetId: input.targetId,
      succeeded: input.succeeded,
    },
  });
  // First send starts the warmup clock.
  await prisma.socialAccount.updateMany({
    where: { id: input.accountId, warmupStartedAt: null },
    data: { warmupStartedAt: new Date() },
  });
  await prisma.socialAccount.update({
    where: { id: input.accountId },
    data: { lastUsedAt: new Date() },
  });
}

/**
 * A platform block was observed. Quarantine the account, halve its caps, and
 * tell a human. Halving matters: whatever rate we were running at was, by
 * demonstration, too fast for this account.
 */
export async function applyBlock(
  organizationId: string,
  accountId: string,
  signal: BlockSignal
): Promise<void> {
  const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) return;

  const hours = COOLDOWN_HOURS[signal.kind];
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

  await prisma.socialAccount.update({
    where: { id: accountId },
    data: {
      cooldownUntil,
      lastBlockKind: signal.kind,
      lastBlockAt: new Date(),
      // A dead session or a suspension isn't a pacing problem — mark the
      // account so nothing tries to use it until a human reconnects.
      ...(signal.severity === 'auth'
        ? { status: 'EXPIRED' as const }
        : signal.severity === 'fatal'
          ? { status: 'ERROR' as const }
          : {}),
      // Back off the pace we were demonstrably running too hot at.
      ...(signal.severity === 'cooldown'
        ? {
            dailyDmCap: Math.max(3, Math.floor(account.dailyDmCap / 2)),
            hourlyDmCap: Math.max(1, Math.floor(account.hourlyDmCap / 2)),
          }
        : {}),
    },
  });

  await notify({
    organizationId,
    type: 'SYSTEM',
    title: `Social account paused — ${account.platform.toLowerCase()}`,
    body:
      `${describeBlock(signal)}. Sending is paused until ${cooldownUntil.toISOString()}` +
      (signal.severity === 'cooldown'
        ? `, and the account's caps were halved.`
        : `. This account needs a human to review and reconnect it.`),
    emailAlert: signal.severity !== 'cooldown',
  });
}

/**
 * Pick the connected, healthy, under-cap account for a platform. Prefers the
 * one with the most headroom so sends spread across accounts instead of
 * hammering the first one to the ceiling.
 */
export interface PickedAccount {
  accountId: string | null;
  permission?: SendPermission;
  /** Why nothing was available, when accountId is null. */
  reason?: string;
}

export async function pickSendingAccount(
  organizationId: string,
  platform: PlatformKey
): Promise<PickedAccount> {
  const accounts = await prisma.socialAccount.findMany({
    where: { organizationId, platform: toPlatformEnum(platform), status: 'CONNECTED' },
  });
  if (!accounts.length) {
    return {
      accountId: null,
      reason: `No connected ${platform} account (Settings → Social accounts).`,
    };
  }

  const scored: { accountId: string; permission: SendPermission; headroom: number }[] = [];
  const reasons: string[] = [];
  for (const account of accounts) {
    const permission = await canSend(account.id);
    if (!permission.allowed) {
      reasons.push(`${account.label}: ${permission.reason}`);
      continue;
    }
    const headroom = (permission.caps?.daily ?? 0) - (permission.caps?.sentToday ?? 0);
    scored.push({ accountId: account.id, permission, headroom });
  }
  if (!scored.length) {
    return { accountId: null, reason: `All ${platform} accounts unavailable — ${reasons.join('; ')}` };
  }
  scored.sort((a, b) => b.headroom - a.headroom);
  return { accountId: scored[0].accountId, permission: scored[0].permission };
}

/**
 * Spacing between sends, jittered. Evenly spaced messages are themselves a
 * signal — a person does not DM exactly every three minutes — so the drain
 * loop spreads the remaining daily allowance across the day with noise.
 */
export function nextSendDelayMs(hourlyCap: number): number {
  const base = (60 * 60 * 1000) / Math.max(1, hourlyCap);
  // 0.6x - 1.8x the nominal spacing.
  return Math.round(base * (0.6 + Math.random() * 1.2));
}
