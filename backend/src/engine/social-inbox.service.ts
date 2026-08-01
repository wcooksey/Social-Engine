import crypto from 'crypto';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { handleInbound } from '../services/inbound.service';
import { notify } from '../services/notification.service';
import { getOrgConfig } from '../services/settings.service';
import {
  loadStorageState,
  saveStorageState,
  PlatformKey,
} from '../services/social-account.service';
import { runBrowserAgent } from './browser/browser-agent.service';

/**
 * The inbound half of the social DM loop. Outbound DMs go out through the
 * browser, but LinkedIn/Facebook/Instagram/X don't webhook replies back to a
 * browser-driven account — so this sweep periodically opens each connected
 * account's DM inbox (read-only), extracts new messages from prospects, and
 * feeds them through handleInbound. From there the existing machinery takes
 * over: cadence pauses, humans get a HOT_REPLY alert, and an SDR agent is
 * queued to read the thread and respond.
 */

const INBOX_URLS: Record<PlatformKey, string> = {
  linkedin: 'https://www.linkedin.com/messaging/',
  facebook: 'https://www.facebook.com/messages/t/',
  instagram: 'https://www.instagram.com/direct/inbox/',
  x: 'https://x.com/messages',
};

const PLATFORM_KEYS: Record<string, PlatformKey> = {
  LINKEDIN: 'linkedin',
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  X: 'x',
};

/** How often each connected account's inbox is read. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SocialSweepResult {
  platform: PlatformKey;
  status: 'completed' | 'failed' | 'skipped';
  found: number;
  matched: number;
  /** Senders we couldn't match to a lead contact (surfaced to humans). */
  unmatched: string[];
  summary?: string;
  error?: string;
}

interface ExtractedReply {
  senderName?: string;
  senderHandle?: string;
  profileUrl?: string;
  message?: string;
}

/**
 * Read one platform's DM inbox for an org and ingest new replies. Runs as its
 * own AgentRun so the browser steps, cost, and outcome land in the Activity
 * audit trail like any other agent work.
 */
export async function sweepSocialInbox(
  organizationId: string,
  platform: PlatformKey
): Promise<SocialSweepResult> {
  const storageState = await loadStorageState(organizationId, platform);
  if (!storageState) {
    return {
      platform,
      status: 'skipped',
      found: 0,
      matched: 0,
      unmatched: [],
      error: `No connected ${platform} account (Settings → Social accounts).`,
    };
  }

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const model = org?.engineModel || config.engine.model;
  const orgConfig = await getOrgConfig(organizationId);

  const run = await prisma.agentRun.create({
    data: {
      organizationId,
      trigger: 'SCHEDULED_JOB',
      role: 'SDR',
      objective: `Social inbox sweep: check ${platform} DMs for new replies`,
      model,
    },
  });

  const objective =
    `You are logged in to ${platform}. Open the direct-message inbox and identify conversations with NEW messages FROM the other person (unread conversations, or ones where the most recent message is theirs, not ours). ` +
    `For each such conversation (up to 10), open it and read their latest message. Do NOT send, type, or submit anything — this is strictly read-only. ` +
    `Then call finish with data = {"replies": [{"senderName": "person or company name", "senderHandle": "their username/handle if visible", "profileUrl": "their profile URL if visible", "message": "the exact text of their latest message"}]}. ` +
    `If nothing is new, finish with data = {"replies": []}.`;

  const result = await runBrowserAgent({
    objective,
    startUrl: INBOX_URLS[platform],
    model,
    providerKeys: orgConfig.providerKeys,
    allowSend: false,
    storageState,
    persistState: (state) => saveStorageState(organizationId, platform, state),
  });

  const replies = extractReplies(result.data);
  let matched = 0;
  const unmatched: string[] = [];

  for (const reply of replies) {
    const message = (reply.message || '').trim();
    if (!message) continue;
    const handle = reply.senderHandle || reply.profileUrl || reply.senderName || '';
    if (!handle) continue;
    // Stable id so re-reading the same thread next sweep ingests nothing twice.
    const externalId = `${platform}:${crypto
      .createHash('sha256')
      .update(`${handle}\n${message}`)
      .digest('hex')
      .slice(0, 24)}`;

    let ingest = await handleInbound({
      organizationId,
      channel: 'SOCIAL',
      socialHandle: handle,
      subject: `${platform} DM`,
      body: message,
      externalId,
    });
    // Handle didn't match a contact — a display name sometimes will.
    if (!ingest.matched && reply.senderName && reply.senderName !== handle) {
      ingest = await handleInbound({
        organizationId,
        channel: 'SOCIAL',
        socialHandle: reply.senderName,
        subject: `${platform} DM`,
        body: message,
        externalId,
      });
    }
    if (ingest.matched) matched++;
    else unmatched.push(reply.senderName || handle);
  }

  // Replies from senders we can't tie to a lead still deserve human eyes.
  if (unmatched.length) {
    await notify({
      organizationId,
      type: 'SYSTEM',
      title: `${unmatched.length} ${platform} DM repl${unmatched.length === 1 ? 'y' : 'ies'} from unrecognized sender${unmatched.length === 1 ? '' : 's'}`,
      body: `Check the ${platform} inbox manually: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''}. To route these automatically, save the sender's profile URL on the lead's contact socials.`,
    });
  }

  const failed = result.status === 'failed';
  const summary = failed
    ? `Sweep failed: ${result.error || result.summary}`
    : `Found ${replies.length} new repl${replies.length === 1 ? 'y' : 'ies'} on ${platform}; matched ${matched} to leads${unmatched.length ? `, ${unmatched.length} unrecognized` : ''}.`;

  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: failed ? 'FAILED' : 'COMPLETED',
      summary: summary.slice(0, 4000),
      ...(failed ? { error: (result.error || '').slice(0, 2000) } : {}),
      inputTokens: { increment: result.usage.inputTokens },
      outputTokens: { increment: result.usage.outputTokens },
      cachedInputTokens: { increment: result.usage.cachedInputTokens },
      costUsd: { increment: result.usage.costUsd },
      finishedAt: new Date(),
    },
  });

  return {
    platform,
    status: failed ? 'failed' : 'completed',
    found: replies.length,
    matched,
    unmatched,
    summary,
    ...(failed ? { error: result.error } : {}),
  };
}

function extractReplies(data: unknown): ExtractedReply[] {
  if (!data || typeof data !== 'object') return [];
  const replies = (data as { replies?: unknown }).replies;
  if (!Array.isArray(replies)) return [];
  return replies
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      senderName: typeof r.senderName === 'string' ? r.senderName : undefined,
      senderHandle: typeof r.senderHandle === 'string' ? r.senderHandle : undefined,
      profileUrl: typeof r.profileUrl === 'string' ? r.profileUrl : undefined,
      message: typeof r.message === 'string' ? r.message : undefined,
    }));
}

/**
 * Worker sweep: read every CONNECTED account's inbox that hasn't been read in
 * the last hour. lastInboxSweepAt is claimed with a conditional update first,
 * so overlapping worker ticks (or multiple instances) never double-sweep.
 */
export async function runSocialInboxSweeps(): Promise<number> {
  const due = await prisma.socialAccount.findMany({
    where: {
      status: 'CONNECTED',
      organization: { paused: false },
      OR: [
        { lastInboxSweepAt: null },
        { lastInboxSweepAt: { lte: new Date(Date.now() - SWEEP_INTERVAL_MS) } },
      ],
    },
    take: 20,
  });

  let swept = 0;
  for (const account of due) {
    const platform = PLATFORM_KEYS[account.platform];
    if (!platform) continue;
    const claimed = await prisma.socialAccount.updateMany({
      where: { id: account.id, updatedAt: account.updatedAt },
      data: { lastInboxSweepAt: new Date() },
    });
    if (claimed.count === 0) continue; // raced another sweep/update
    try {
      await sweepSocialInbox(account.organizationId, platform);
      swept++;
    } catch (err) {
      console.error(
        `Social inbox sweep error (${platform}, org ${account.organizationId}):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return swept;
}
