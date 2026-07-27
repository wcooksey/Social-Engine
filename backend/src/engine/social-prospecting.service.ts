import { prisma } from '../config/database';
import { config } from '../config/environment';
import { getOrgConfig } from '../services/settings.service';
import {
  loadAccountById,
  PlatformKey,
  saveStateForAccount,
  toPlatformEnum,
} from '../services/social-account.service';
import {
  applyBlock,
  canSend,
  nextSendDelayMs,
  pickSendingAccount,
} from '../services/social-limits.service';
import { detectBlock } from './browser/block-detector';
import { BrowserSession } from './browser/browser.service';
import { llmService } from './llm/llm.service';
import { sendDmToProfile } from './social-outreach.service';

/**
 * Follower harvesting and the DM queue that drains from it.
 *
 * Two deliberately separate loops:
 *
 *  - harvest: walk a list (followers of an account, likers of a post) and
 *    record everyone found. No sends. Fragile — list UIs are virtualised and
 *    change often — but cheap to retry, and losing a run costs nothing because
 *    the unique (org, platform, handle) constraint makes every write an upsert.
 *
 *  - drain: take qualified prospects and message them, one at a time, under
 *    per-account caps with jittered spacing.
 *
 * Keeping them apart means a scroll that dies at follower 400 still banks 399,
 * and a rate limit hit while sending never costs a harvest.
 *
 * Harvesting does NOT run through the LLM agent loop. Reading 500 names via
 * observe/decide/act would be 500+ model calls to do what one selector does;
 * the model is used only to qualify, in batches.
 */

interface PlatformHarvestSpec {
  /** Build the URL that shows the list. */
  listUrl: (handle: string, kind: string) => string;
  /** Scroll container for the virtualised list, or null to scroll the window. */
  scrollSelector: string | null;
  /** Which links in that container are profiles. */
  profileHref: RegExp;
  /** Pull a handle out of a profile URL. */
  handleFrom: (url: string) => string | null;
}

/**
 * NOTE: these selectors describe each platform's list UI as of writing. They
 * are the part of this file most likely to rot — platforms reshuffle their DOM
 * routinely, and none of them is a documented interface. `harvestSource`
 * reports "0 found" loudly rather than silently succeeding so a stale selector
 * surfaces as an error instead of an empty list.
 */
const HARVEST: Record<PlatformKey, PlatformHarvestSpec | null> = {
  instagram: {
    listUrl: (handle, kind) =>
      `https://www.instagram.com/${handle}/${kind === 'FOLLOWING' ? 'following' : 'followers'}/`,
    scrollSelector: 'div[role="dialog"] div[style*="overflow"]',
    profileHref: /^https:\/\/www\.instagram\.com\/[A-Za-z0-9._]+\/?$/,
    handleFrom: (url) => url.match(/instagram\.com\/([A-Za-z0-9._]+)\/?$/)?.[1] || null,
  },
  x: {
    listUrl: (handle, kind) =>
      `https://x.com/${handle}/${kind === 'FOLLOWING' ? 'following' : 'verified_followers'}`,
    scrollSelector: null,
    profileHref: /^https:\/\/x\.com\/[A-Za-z0-9_]+$/,
    handleFrom: (url) => url.match(/x\.com\/([A-Za-z0-9_]+)$/)?.[1] || null,
  },
  // Facebook renders follower lists inconsistently across page types and often
  // hides them entirely; LinkedIn does not expose a follower list at all and
  // aggressively rate-limits connection browsing. Both are unsupported rather
  // than half-supported — a harvester that half-works on these is worse than
  // one that says it can't.
  facebook: null,
  linkedin: null,
};

/** URLs that appear in a follower list but aren't people. */
const NON_PROFILE = /\/(p|reel|explore|accounts|direct|stories|about|privacy|terms|i)\//i;

export interface HarvestResult {
  status: 'completed' | 'exhausted' | 'blocked' | 'failed' | 'unsupported';
  found: number;
  added: number;
  summary: string;
}

/**
 * Walk one source's list and bank everyone found. Resumable: stops after
 * `maxScrolls` and records where it got to, so repeated short runs cover a big
 * list without one enormous session that the platform is more likely to notice.
 */
export async function harvestSource(
  organizationId: string,
  sourceId: string,
  opts: { maxScrolls?: number; accountId?: string } = {}
): Promise<HarvestResult> {
  const source = await prisma.socialSource.findFirst({
    where: { id: sourceId, organizationId },
  });
  if (!source) return { status: 'failed', found: 0, added: 0, summary: 'Source not found.' };

  const platform = source.platform.toLowerCase() as PlatformKey;
  const spec = HARVEST[platform];
  if (!spec) {
    await prisma.socialSource.update({
      where: { id: sourceId },
      data: { status: 'FAILED', lastError: `Harvesting is not supported on ${platform}.` },
    });
    return {
      status: 'unsupported',
      found: 0,
      added: 0,
      summary: `Follower harvesting isn't supported on ${platform} — the platform doesn't expose a usable list.`,
    };
  }

  const accountId =
    opts.accountId || (await pickSendingAccount(organizationId, platform)).accountId;
  if (!accountId) {
    return {
      status: 'failed',
      found: 0,
      added: 0,
      summary: `No connected ${platform} account to browse with.`,
    };
  }
  const account = await loadAccountById(accountId, organizationId);
  if (!account) {
    return { status: 'failed', found: 0, added: 0, summary: 'Account session could not be loaded.' };
  }

  await prisma.socialSource.update({
    where: { id: sourceId },
    data: { status: 'HARVESTING', lastRunAt: new Date() },
  });

  const session = new BrowserSession();
  const maxScrolls = opts.maxScrolls ?? 25;
  const seen = new Map<string, { profileUrl: string; displayName?: string }>();

  try {
    await session.open({
      storageState: account.storageState,
      ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    });

    const obs = await session.goto(spec.listUrl(source.handle, source.kind));
    if (obs.block) {
      await applyBlock(organizationId, accountId, obs.block);
      await session.close();
      await prisma.socialSource.update({
        where: { id: sourceId },
        data: { status: 'PAUSED', lastError: obs.block.evidence },
      });
      return {
        status: 'blocked',
        found: 0,
        added: 0,
        summary: `Blocked opening the list: ${obs.block.evidence}. Account paused.`,
      };
    }

    // Scroll until the list stops producing new handles. Two barren rounds is
    // the end-of-list signal — one can just be a slow lazy load.
    let barren = 0;
    for (let i = 0; i < maxScrolls && barren < 2; i++) {
      const before = seen.size;
      const links = await session.extractLinks(spec.scrollSelector, spec.profileHref);
      for (const link of links) {
        if (NON_PROFILE.test(link.href)) continue;
        const handle = spec.handleFrom(link.href);
        if (!handle || handle.toLowerCase() === source.handle.toLowerCase()) continue;
        if (!seen.has(handle)) {
          seen.set(handle, {
            profileUrl: link.href,
            ...(link.text ? { displayName: link.text.split('\n')[0].slice(0, 120) } : {}),
          });
        }
      }
      barren = seen.size > before ? 0 : barren + 1;
      await session.scrollContainer(spec.scrollSelector, 1);

      // Re-screen between scrolls: a rate limit usually appears mid-walk, and
      // continuing to scroll into it is what escalates it.
      const mid = detectBlock(session.currentUrl(), '');
      if (mid) {
        await applyBlock(organizationId, accountId, mid);
        break;
      }
    }

    const refreshed = await session.exportState();
    await saveStateForAccount(accountId, refreshed);
    await session.close();

    // Bank everything. createMany+skipDuplicates makes a re-run over an
    // already-harvested stretch a no-op instead of a duplicate.
    let added = 0;
    if (seen.size) {
      const created = await prisma.socialProspect.createMany({
        data: [...seen.entries()].map(([handle, v]) => ({
          organizationId,
          sourceId,
          platform: source.platform,
          handle,
          profileUrl: v.profileUrl,
          ...(v.displayName ? { displayName: v.displayName } : {}),
        })),
        skipDuplicates: true,
      });
      added = created.count;
    }

    const exhausted = barren >= 2;
    const cursor = [...seen.keys()].pop() || source.cursor;
    await prisma.socialSource.update({
      where: { id: sourceId },
      data: {
        status: exhausted ? 'EXHAUSTED' : 'PENDING',
        harvestedCount: { increment: added },
        ...(cursor ? { cursor } : {}),
        lastError:
          seen.size === 0
            ? 'Found no profile links — the platform DOM may have changed, or the list is private.'
            : null,
      },
    });

    return {
      status: exhausted ? 'exhausted' : 'completed',
      found: seen.size,
      added,
      summary:
        seen.size === 0
          ? `Found 0 profiles. Either the list is private/empty, or ${platform}'s list markup changed and the harvest selectors need updating.`
          : `Saw ${seen.size} profiles, ${added} new.${exhausted ? ' Reached the end of the list.' : ''}`,
    };
  } catch (err) {
    await session.close().catch(() => undefined);
    const message = err instanceof Error ? err.message : 'Harvest failed';
    await prisma.socialSource.update({
      where: { id: sourceId },
      data: { status: 'PENDING', lastError: message },
    });
    return { status: 'failed', found: 0, added: 0, summary: message };
  }
}

/**
 * Judge harvested prospects against the source's filter, in batches.
 *
 * One model call per batch, not per prospect: qualification is a cheap text
 * judgement over a name and a bio, and doing it individually would cost ~50x
 * for no gain in accuracy.
 */
export async function qualifyNewProspects(
  organizationId: string,
  sourceId: string,
  limit = 50
): Promise<{ qualified: number; rejected: number; note?: string }> {
  const source = await prisma.socialSource.findFirst({ where: { id: sourceId, organizationId } });
  if (!source) return { qualified: 0, rejected: 0, note: 'Source not found.' };

  const batch = await prisma.socialProspect.findMany({
    where: { organizationId, sourceId, status: 'NEW' },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });
  if (!batch.length) return { qualified: 0, rejected: 0, note: 'Nothing new to qualify.' };

  // With no filter, everything harvested is fair game — but say so, rather
  // than silently qualifying a whole follower list.
  if (!source.qualifyPrompt) {
    await prisma.socialProspect.updateMany({
      where: { id: { in: batch.map((p) => p.id) } },
      data: { status: 'QUALIFIED', qualifyReason: 'No filter set on this source.' },
    });
    return {
      qualified: batch.length,
      rejected: 0,
      note: 'No qualifyPrompt on this source, so every harvested profile was accepted. Set one to filter.',
    };
  }

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const orgConfig = await getOrgConfig(organizationId);
  const roster = batch
    .map(
      (p, i) =>
        `${i}. @${p.handle}${p.displayName ? ` — ${p.displayName}` : ''}${p.bio ? ` — bio: ${p.bio.slice(0, 200)}` : ''}`
    )
    .join('\n');

  const response = await llmService.chatWithFailover(
    {
      model: org?.engineModel || config.engine.model,
      system:
        `You are filtering a harvested list of social profiles for a sales team.\n` +
        `Accept a profile ONLY if it plausibly matches: "${source.qualifyPrompt}".\n` +
        `Be strict — a wrongly accepted profile becomes an unwanted cold DM to a real person. ` +
        `When a profile has no bio and an uninformative name, REJECT it: absence of evidence is not a match.\n` +
        `Reply with JSON only: {"decisions":[{"i":0,"accept":true,"reason":"short reason"}]}`,
      messages: [{ role: 'user', content: roster }],
      tools: [],
      maxTokens: 4000,
    },
    orgConfig.providerKeys
  );

  let decisions: { i: number; accept: boolean; reason?: string }[] = [];
  try {
    const json = response.text.match(/\{[\s\S]*\}/)?.[0] || '{}';
    decisions = JSON.parse(json).decisions || [];
  } catch {
    return { qualified: 0, rejected: 0, note: 'Qualifier returned unparseable output; left as NEW to retry.' };
  }

  let qualified = 0;
  let rejected = 0;
  for (const d of decisions) {
    const prospect = batch[d.i];
    if (!prospect) continue;
    await prisma.socialProspect.update({
      where: { id: prospect.id },
      data: {
        status: d.accept ? 'QUALIFIED' : 'REJECTED',
        qualifyReason: (d.reason || '').slice(0, 300),
      },
    });
    d.accept ? qualified++ : rejected++;
  }
  return { qualified, rejected };
}

export interface DrainResult {
  sent: number;
  skipped: number;
  stoppedBecause?: string;
}

/**
 * Send to qualified prospects, one at a time, until the account's budget runs
 * out or `max` is reached.
 *
 * Claiming is atomic (updateMany guarded on status) so two workers can never
 * pick up the same prospect and double-message a real person.
 */
export async function drainProspectQueue(
  organizationId: string,
  platform: PlatformKey,
  opts: { max?: number; runId: string; sourceId?: string }
): Promise<DrainResult> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) return { sent: 0, skipped: 0, stoppedBecause: 'Organization not found.' };
  if (org.paused) return { sent: 0, skipped: 0, stoppedBecause: 'Organization is paused (kill switch).' };
  if (!org.socialAutonomy) {
    return {
      sent: 0,
      skipped: 0,
      stoppedBecause:
        'Social autonomy is off — prospect DMs are never sent automatically until it is enabled in Settings.',
    };
  }

  const picked = await pickSendingAccount(organizationId, platform);
  if (!picked.accountId) return { sent: 0, skipped: 0, stoppedBecause: picked.reason };
  const accountId = picked.accountId;

  const max = opts.max ?? 10;
  let sent = 0;
  let skipped = 0;

  for (let i = 0; i < max; i++) {
    const permission = await canSend(accountId);
    if (!permission.allowed) {
      return { sent, skipped, stoppedBecause: permission.reason };
    }

    const next = await prisma.socialProspect.findFirst({
      where: {
        organizationId,
        platform: toPlatformEnum(platform),
        status: 'QUALIFIED',
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { source: true },
    });
    if (!next) return { sent, skipped, stoppedBecause: 'No qualified prospects left in the queue.' };

    // Atomic claim: whoever flips QUALIFIED -> DM_QUEUED owns this prospect.
    const claimed = await prisma.socialProspect.updateMany({
      where: { id: next.id, status: 'QUALIFIED' },
      data: { status: 'DM_QUEUED', accountId, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // raced another worker

    const template =
      next.source?.messageTemplate ||
      `Hi{{name}} — saw you follow @${next.source?.handle || ''} and thought I'd reach out.`;
    const body = template.replace(
      /\{\{\s*name\s*\}\}/g,
      next.displayName ? ` ${next.displayName.split(/\s+/)[0]}` : ''
    );

    const result = await sendDmToProfile({
      organizationId,
      runId: opts.runId,
      platform,
      profileUrl: next.profileUrl,
      message: body,
      targetType: 'prospect',
      targetId: next.id,
      accountId,
    });

    if (result.status === 'sent') {
      await prisma.socialProspect.update({
        where: { id: next.id },
        data: { status: 'DM_SENT', dmSentAt: new Date(), dmBody: body, lastError: null },
      });
      sent++;
    } else if (result.status === 'blocked') {
      // Put it back — it was never messaged, and the block is not its fault.
      await prisma.socialProspect.update({
        where: { id: next.id },
        data: { status: 'QUALIFIED', lastError: result.summary.slice(0, 300) },
      });
      return { sent, skipped, stoppedBecause: `Platform block — ${result.summary}` };
    } else if (result.status === 'rate_limited' || result.status === 'no_account') {
      await prisma.socialProspect.update({
        where: { id: next.id },
        data: { status: 'QUALIFIED' },
      });
      return { sent, skipped, stoppedBecause: result.summary };
    } else {
      await prisma.socialProspect.update({
        where: { id: next.id },
        data: {
          status: next.attempts >= 2 ? 'FAILED' : 'QUALIFIED',
          lastError: result.summary.slice(0, 300),
        },
      });
      skipped++;
    }

    // Space the next send out. Uniform intervals are themselves a bot signal —
    // nobody DMs exactly every three minutes — so this is jittered, and it is
    // a real wait rather than a queue delay because the browser session for the
    // next send starts immediately after.
    if (i < max - 1) {
      const delay = nextSendDelayMs(permission.caps?.hourly ?? 4);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { sent, skipped };
}
