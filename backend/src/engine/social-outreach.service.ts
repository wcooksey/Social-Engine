import { prisma } from '../config/database';
import { config } from '../config/environment';
import { getOrgConfig } from '../services/settings.service';
import {
  loadAccountById,
  PlatformKey,
  saveStateForAccount,
} from '../services/social-account.service';
import { applyBlock, canSend, pickSendingAccount, recordSend } from '../services/social-limits.service';
import { runBrowserAgent } from './browser/browser-agent.service';
import { recordBrowserAction, recordBrowserFrame } from './live-view.registry';

/**
 * The outbound half of social: resolving a human to a profile, then messaging
 * that profile.
 *
 * These are deliberately two separate operations. Resolution is reversible
 * research; sending is not. Fusing them into one agent loop — "find the GM of
 * Sunshine Toyota and DM them" — means a misidentification becomes a cold DM to
 * a stranger with no checkpoint in between, and a DM cannot be recalled. So
 * resolution runs read-only, produces scored candidates, and the send refuses
 * to run without a resolved URL it can be held to.
 */

export interface ProfileCandidate {
  profileUrl: string;
  handle?: string;
  displayName?: string;
  bio?: string;
  /** What the agent actually observed that ties this profile to the target. */
  evidence?: string;
  /** 0-1, computed here — not taken from the model's self-report. */
  confidence: number;
  reasons: string[];
}

export interface ResolveResult {
  status: 'resolved' | 'ambiguous' | 'not_found' | 'blocked' | 'failed';
  best?: ProfileCandidate;
  candidates: ProfileCandidate[];
  summary: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

/** Below this, a profile is never messaged autonomously. */
export const AUTOSEND_CONFIDENCE = 0.6;

function tokens(s: string | null | undefined): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Score a candidate against what we independently know about the target.
 *
 * Scored here rather than asking the model for a confidence number, because a
 * self-reported confidence is just the model's prose restated — it correlates
 * with how fluent the page looked, not with whether this is the right person.
 * These signals are checkable facts.
 */
export function scoreCandidate(
  candidate: Omit<ProfileCandidate, 'confidence' | 'reasons'>,
  target: {
    personName?: string | null;
    companyName?: string | null;
    domain?: string | null;
    city?: string | null;
    state?: string | null;
  }
): ProfileCandidate {
  const haystack = `${candidate.displayName || ''} ${candidate.bio || ''} ${candidate.handle || ''} ${candidate.evidence || ''}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const nameTokens = tokens(target.personName);
  if (nameTokens.length) {
    const display = (candidate.displayName || '').toLowerCase();
    const matched = nameTokens.filter((t) => display.includes(t));
    if (matched.length === nameTokens.length) {
      score += 0.35;
      reasons.push('full name matches the profile name');
    } else if (matched.length) {
      score += 0.15;
      reasons.push('part of the name matches');
    }
  }

  if (target.domain && haystack.includes(target.domain.toLowerCase())) {
    score += 0.3;
    reasons.push(`profile links or mentions ${target.domain}`);
  }

  const companyTokens = tokens(target.companyName).filter(
    (t) => !['inc', 'llc', 'the', 'and', 'company', 'group'].includes(t)
  );
  if (companyTokens.length) {
    const hits = companyTokens.filter((t) => haystack.includes(t));
    if (hits.length >= Math.ceil(companyTokens.length / 2)) {
      score += 0.2;
      reasons.push('company name appears in the profile');
    }
  }

  for (const place of [target.city, target.state]) {
    if (place && haystack.includes(place.toLowerCase())) {
      score += 0.075;
      reasons.push(`location matches (${place})`);
    }
  }

  return { ...candidate, confidence: Math.min(1, Number(score.toFixed(2))), reasons };
}

/**
 * Research-only: find candidate profiles for a person. Sends nothing, so this
 * is safe to run broadly and to re-run.
 */
export async function resolveSocialProfile(input: {
  organizationId: string;
  runId: string;
  platform: PlatformKey;
  personName?: string;
  leadId?: string;
  extraContext?: string;
}): Promise<ResolveResult> {
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  const orgConfig = await getOrgConfig(input.organizationId);
  const model = org?.engineModel || config.engine.model;

  const lead = input.leadId
    ? await prisma.lead.findFirst({
        where: { id: input.leadId, organizationId: input.organizationId },
      })
    : null;

  const picked = await pickSendingAccount(input.organizationId, input.platform);
  const account = picked.accountId
    ? await loadAccountById(picked.accountId, input.organizationId)
    : null;

  const who = input.personName || 'the owner or general manager';
  const where = lead
    ? `${lead.companyName}${lead.city ? ` in ${lead.city}${lead.state ? `, ${lead.state}` : ''}` : ''}${lead.website ? ` (website: ${lead.website})` : ''}`
    : 'the target business';

  const objective =
    `Find the ${input.platform} profile of ${who} at ${where}. ` +
    `${input.extraContext ? `Context: ${input.extraContext}. ` : ''}` +
    `Do NOT message anyone — this is research only.\n\n` +
    `Return up to 3 candidate profiles. For EACH candidate call finish with data shaped as ` +
    `{"candidates":[{"profileUrl":"...","handle":"...","displayName":"...","bio":"...","evidence":"what on the page ties this profile to the target — a linked website, a bio mentioning the business, a location"}]}. ` +
    `Only include a candidate if you actually opened its profile and read it. ` +
    `If you cannot find anyone plausible, return an empty candidates array rather than guessing.`;

  const result = await runBrowserAgent({
    objective,
    model,
    providerKeys: orgConfig.providerKeys,
    allowSend: false,
    ...(account ? { storageState: account.storageState } : {}),
    ...(account?.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    ...(account ? { persistState: (state) => saveStateForAccount(account.id, state) } : {}),
    ...(picked.accountId
      ? { onBlock: (signal) => applyBlock(input.organizationId, picked.accountId!, signal) }
      : {}),
    onStep: (n) => recordBrowserAction(input.runId, input.organizationId, n),
    onFrame: (f) => recordBrowserFrame(input.runId, input.organizationId, f),
  });

  if (result.status === 'blocked') {
    return { status: 'blocked', candidates: [], summary: result.summary, usage: result.usage };
  }
  if (result.status === 'failed') {
    return { status: 'failed', candidates: [], summary: result.summary, usage: result.usage };
  }

  const raw = (result.data as { candidates?: unknown[] } | undefined)?.candidates;
  const candidates = (Array.isArray(raw) ? raw : [])
    .map((c) => c as Record<string, string>)
    .filter((c) => typeof c.profileUrl === 'string' && /^https?:\/\//i.test(c.profileUrl))
    .map((c) =>
      scoreCandidate(
        {
          profileUrl: c.profileUrl,
          handle: c.handle,
          displayName: c.displayName,
          bio: c.bio,
          evidence: c.evidence,
        },
        {
          personName: input.personName,
          companyName: lead?.companyName,
          domain: lead?.domain,
          city: lead?.city,
          state: lead?.state,
        }
      )
    )
    .sort((a, b) => b.confidence - a.confidence);

  if (!candidates.length) {
    return { status: 'not_found', candidates: [], summary: result.summary, usage: result.usage };
  }

  const best = candidates[0];
  // "Ambiguous" also covers the case where two candidates score nearly the
  // same — a confident-looking top score means nothing if a second profile is
  // just as good a match.
  const contested =
    candidates.length > 1 && candidates[1].confidence >= best.confidence - 0.1;
  const status =
    best.confidence >= AUTOSEND_CONFIDENCE && !contested ? 'resolved' : 'ambiguous';

  return { status, best, candidates, summary: result.summary, usage: result.usage };
}

export interface DmSendResult {
  status: 'sent' | 'rate_limited' | 'blocked' | 'failed' | 'no_account';
  accountId?: string;
  summary: string;
  retryAt?: Date;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * Send one DM to an already-resolved profile URL. Every guardrail that matters
 * runs before the browser is even opened.
 */
export async function sendDmToProfile(input: {
  organizationId: string;
  runId: string;
  platform: PlatformKey;
  profileUrl: string;
  message: string;
  targetType: 'lead' | 'prospect';
  targetId: string;
  /** Pin to a specific account (prospects are pinned at qualify time). */
  accountId?: string;
}): Promise<DmSendResult> {
  let accountId = input.accountId;
  if (accountId) {
    const permission = await canSend(accountId);
    if (!permission.allowed) {
      return {
        status: 'rate_limited',
        accountId,
        summary: permission.reason || 'Account unavailable.',
        ...(permission.retryAt ? { retryAt: permission.retryAt } : {}),
      };
    }
  } else {
    const picked = await pickSendingAccount(input.organizationId, input.platform);
    if (!picked.accountId) {
      return { status: 'no_account', summary: picked.reason || 'No usable account.' };
    }
    accountId = picked.accountId;
  }

  const account = await loadAccountById(accountId, input.organizationId);
  if (!account) {
    return {
      status: 'no_account',
      summary: `The ${input.platform} account could not be loaded — reconnect it in Settings.`,
    };
  }

  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  const orgConfig = await getOrgConfig(input.organizationId);
  const model = org?.engineModel || config.engine.model;

  const objective =
    `You are already logged in to ${input.platform}. Open exactly this profile: ${input.profileUrl}\n` +
    `Send that person this direct message, verbatim:\n"""${input.message}"""\n\n` +
    `Rules:\n` +
    `- Message ONLY the profile at that exact URL. If it does not load, or resolves to a different person, call finish WITHOUT sending.\n` +
    `- Send exactly one message. Do not follow, like, comment, or connect.\n` +
    `- Confirm the message appears in the thread before calling finish, and say so explicitly in your summary.`;

  const result = await runBrowserAgent({
    objective,
    startUrl: input.profileUrl,
    model,
    providerKeys: orgConfig.providerKeys,
    allowSend: true,
    storageState: account.storageState,
    ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    persistState: (state) => saveStateForAccount(account.id, state),
    onBlock: (signal) => applyBlock(input.organizationId, account.id, signal),
    onStep: (n) => recordBrowserAction(input.runId, input.organizationId, n),
    onFrame: (f) => recordBrowserFrame(input.runId, input.organizationId, f),
  });

  if (result.status === 'blocked') {
    return { status: 'blocked', accountId, summary: result.summary, usage: result.usage };
  }

  const sent = result.status === 'completed';
  // Count the attempt against the budget either way when the browser actually
  // drove the flow: a failed attempt still consumed platform-visible actions.
  await recordSend({
    organizationId: input.organizationId,
    accountId,
    platform: input.platform,
    targetType: input.targetType,
    targetId: input.targetId,
    succeeded: sent,
  });

  return {
    status: sent ? 'sent' : 'failed',
    accountId,
    summary: result.summary,
    usage: result.usage,
  };
}
