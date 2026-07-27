/**
 * Platform block / checkpoint detection.
 *
 * The single biggest risk in autonomous social work is an agent that keeps
 * clicking after the platform has already said "stop". A soft action-block that
 * would expire in a few hours becomes a permanent ban when an automation
 * retries into it. So every observation is screened here, and a hit aborts the
 * run immediately rather than burning the remaining steps.
 *
 * Detection is intentionally conservative on the URL side (URLs are
 * unambiguous) and tight on the text side — loose phrases like "blocked" or
 * "verify" appear all over normal logged-in pages and would quarantine healthy
 * accounts.
 */

export type BlockKind =
  | 'action_block' // "We restrict certain activity" — temporary, action-scoped
  | 'rate_limit' // "Please wait a few minutes"
  | 'checkpoint' // identity challenge / security check
  | 'captcha'
  | 'suspended' // account disabled
  | 'login_required'; // session died mid-run

/**
 * What the caller should do about it.
 *  - cooldown: pause this account for hours, then resume at a reduced rate.
 *  - auth: the stored session is dead; a human must reconnect the account.
 *  - fatal: stop and escalate — retrying makes it worse.
 */
export type BlockSeverity = 'cooldown' | 'auth' | 'fatal';

export interface BlockSignal {
  kind: BlockKind;
  severity: BlockSeverity;
  /** The matched phrase/url fragment, for the audit trail and human triage. */
  evidence: string;
}

const SEVERITY: Record<BlockKind, BlockSeverity> = {
  action_block: 'cooldown',
  rate_limit: 'cooldown',
  checkpoint: 'fatal',
  captcha: 'fatal',
  suspended: 'fatal',
  login_required: 'auth',
};

/** How long to quarantine an account after each kind of hit. */
export const COOLDOWN_HOURS: Record<BlockKind, number> = {
  rate_limit: 3,
  action_block: 24,
  checkpoint: 72,
  captcha: 24,
  suspended: 24 * 30,
  login_required: 24 * 7,
};

interface Rule {
  kind: BlockKind;
  url?: RegExp;
  text?: RegExp;
}

/**
 * Cross-platform rules. Kept as one list because Meta surfaces near-identical
 * copy on Instagram and Facebook, and a stray match on the wrong platform is
 * harmless — the response (pause and tell a human) is the same either way.
 */
const RULES: Rule[] = [
  // --- hard checkpoints / challenges -------------------------------------
  { kind: 'checkpoint', url: /\/challenge\/|challenge_required|\/checkpoint\//i },
  { kind: 'checkpoint', url: /linkedin\.com\/checkpoint\/challenge/i },
  { kind: 'checkpoint', url: /x\.com\/account\/access|twitter\.com\/account\/access/i },
  {
    kind: 'checkpoint',
    text: /suspicious login attempt|confirm it'?s you|let'?s do a quick security check|help us confirm|confirm your identity|we need to verify your identity|unusual (login )?activity/i,
  },

  // --- account suspension -------------------------------------------------
  { kind: 'suspended', url: /\/accounts\/suspended|\/accounts\/disabled/i },
  {
    kind: 'suspended',
    text: /your account has been (disabled|suspended|permanently)|we (have )?(disabled|suspended) your account|account has been locked/i,
  },

  // --- action blocks (temporary, action-scoped) ---------------------------
  {
    kind: 'action_block',
    text: /action blocked|we restrict certain activity|you'?re temporarily blocked|temporarily restricted from|this action was blocked|you can'?t use this feature right now|we limit how often/i,
  },
  {
    kind: 'action_block',
    text: /we'?ve restricted (your account|certain activity)|your account is (temporarily )?restricted/i,
  },

  // --- soft rate limits ---------------------------------------------------
  {
    kind: 'rate_limit',
    text: /try again later|please wait a few minutes|you'?re sending messages too (fast|quickly)|slow down|too many requests|rate limit exceeded/i,
  },

  // --- captcha ------------------------------------------------------------
  {
    kind: 'captcha',
    text: /i'?m not a robot|verify you are human|enter the characters you see|complete the security check|recaptcha|hcaptcha/i,
  },

  // --- session death ------------------------------------------------------
  {
    kind: 'login_required',
    url: /instagram\.com\/accounts\/login|facebook\.com\/login|linkedin\.com\/(uas\/)?login|linkedin\.com\/authwall|x\.com\/i\/flow\/login/i,
  },
  {
    kind: 'login_required',
    text: /log in to (instagram|facebook|linkedin)|sign up to see|create new account/i,
  },
];

/**
 * Screen one page observation. Returns the highest-severity signal found, or
 * null when the page looks healthy.
 *
 * `text` should be the visible body text — matching raw HTML produces constant
 * false positives, because platforms ship this copy inside JS bundles on every
 * page whether or not it is being shown.
 */
export function detectBlock(url: string, text: string): BlockSignal | null {
  // Only the first stretch of body text matters: blocks render as an
  // interstitial or dialog at the top. Scanning the whole page picks up footer
  // help-center links ("Why was my account restricted?") on healthy pages.
  const head = text.slice(0, 2500);
  const hits: BlockSignal[] = [];

  for (const rule of RULES) {
    if (rule.url) {
      const m = url.match(rule.url);
      if (m) hits.push({ kind: rule.kind, severity: SEVERITY[rule.kind], evidence: `url: ${m[0]}` });
    }
    if (rule.text) {
      const m = head.match(rule.text);
      if (m) hits.push({ kind: rule.kind, severity: SEVERITY[rule.kind], evidence: `text: "${m[0]}"` });
    }
  }
  if (!hits.length) return null;

  const rank: Record<BlockSeverity, number> = { fatal: 3, auth: 2, cooldown: 1 };
  return hits.sort((a, b) => rank[b.severity] - rank[a.severity])[0];
}

export function describeBlock(signal: BlockSignal): string {
  const label: Record<BlockKind, string> = {
    action_block: 'Platform action block',
    rate_limit: 'Platform rate limit',
    checkpoint: 'Security checkpoint / identity challenge',
    captcha: 'CAPTCHA challenge',
    suspended: 'Account suspended or disabled',
    login_required: 'Session expired (logged out)',
  };
  return `${label[signal.kind]} — ${signal.evidence}`;
}
