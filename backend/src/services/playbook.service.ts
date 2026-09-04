import { prisma } from '../config/database';

export interface PlaybookForPrompt {
  name: string;
  scopeLabel: string;
  channel: string;
  instructions: string;
  /** "Send as" line, when the playbook carries a sender identity. */
  identityLabel?: string;
  /** "Sends from" line, when this playbook leaves through a connected inbox. */
  transportLabel?: string;
}

/**
 * Load active playbooks formatted for prompt injection. Every Engine run gets
 * the full protocol set with scope labels; the system prompt instructs the
 * model to apply the ones matching the leads/channel it is working.
 */
export async function getActivePlaybooks(organizationId: string): Promise<PlaybookForPrompt[]> {
  const playbooks = await prisma.playbook.findMany({
    where: { organizationId, isActive: true },
    include: {
      group: { select: { name: true } },
      campaign: { select: { name: true } },
      gmailAccount: { select: { emailAddress: true } },
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });

  return playbooks.map((p) => {
    let scopeLabel = 'Applies to: everything';
    if (p.scope === 'GROUP' && p.group) scopeLabel = `Applies to: leads in group "${p.group.name}"`;
    if (p.scope === 'CAMPAIGN' && p.campaign)
      scopeLabel = `Applies to: leads in campaign "${p.campaign.name}"`;
    if (p.scope === 'LEAD_STATUS' && p.leadStatus)
      scopeLabel = `Applies to: leads with status ${p.leadStatus}`;
    return {
      name: p.name,
      scopeLabel,
      channel: p.channel,
      instructions: p.instructions,
      identityLabel: identityLabel(p),
      transportLabel: transportLabel(p),
    };
  });
}

/**
 * The one line about transport the model actually needs.
 *
 * Not a configuration dump — what changes is how the email should READ. Mail
 * leaving a person's own inbox at twenty a day is a note from a colleague and
 * is judged as one; the same text sent from a warmed prospecting domain is
 * campaign mail. The model cannot see which it is unless told, and it writes
 * very differently once it knows.
 */
function transportLabel(p: {
  emailTransport: string;
  gmailAccount: { emailAddress: string } | null;
}): string | undefined {
  if (p.emailTransport !== 'GMAIL') return undefined;
  const address = p.gmailAccount?.emailAddress;
  return (
    `Sends from: a real Gmail inbox${address ? ` (${address})` : ''}, not a bulk sending domain. ` +
    'Volume here is low and every message is read as a personal note — write one email to one ' +
    'person, referencing something specific you actually found about their business. No merge-mail ' +
    'phrasing, no campaign framing, no "I wanted to reach out to businesses like yours". Replies ' +
    'land in that inbox and thread back onto the lead automatically.'
  );
}

/** One-line summary of a playbook's sender identity, or undefined if it has none. */
function identityLabel(p: {
  identityName: string | null;
  identityOrgName: string | null;
  identityTitle: string | null;
  identityEmail: string | null;
  identitySignature: string | null;
}): string | undefined {
  const who = p.identityName?.trim();
  const brand = p.identityOrgName?.trim();
  const title = p.identityTitle?.trim();
  if (!who && !brand && !title && !p.identityEmail && !p.identitySignature) return undefined;

  const parts: string[] = [];
  if (who) parts.push(title ? `${who}, ${title}` : who);
  if (brand) parts.push(who ? `of ${brand}` : brand);
  else if (title && !who) parts.push(title);
  const sig = p.identitySignature?.trim();
  return `Send as: ${parts.join(' ') || 'the organization'}${sig ? `\nSign off with:\n${sig}` : ''}`;
}

/**
 * The precedence rule `resolveSenderIdentity` actually applies, stated for the
 * model.
 *
 * The prompt lists EVERY active playbook with no scope or channel filter,
 * because one run works many leads. The resolver filters by both and applies a
 * specific-beats-global tie-break. Left unsaid, the model would compose toward
 * whichever "Send as" line it read first and the platform would stamp a
 * different one — an email From "Mike" signed "Sarah", which is precisely the
 * shape of a phishing message. Stating the rule is what keeps the two in step.
 */
function identityPrecedenceNote(): string {
  return (
    '\nIMPORTANT — which identity applies to a given lead is decided by the platform, not by you, ' +
    'and it uses this exact rule: among playbooks that carry a "Send as" line, only those whose ' +
    'scope matches THAT lead (its group, its campaign, or its status) and whose channel matches ' +
    'the one you are sending on are eligible; a scoped playbook beats a GLOBAL one; then the lowest ' +
    'priority number wins. Every playbook below is listed regardless of scope, so more "Send as" ' +
    'lines are visible to you than can apply to any one lead.\n' +
    'Because of that, and because the sending mailbox is only chosen after you finish writing, ' +
    'NEVER type a sender name or a sign-off into a message body. Write the body only. The platform ' +
    'appends the correct signature and sets the From header to match the address that actually ' +
    'carries the send.\n'
  );
}

/**
 * The playbook a conversation is filed under, if it still exists and is active.
 * Used to tell a run which line of business it is working — the difference
 * between a tag on a chat list and a chat that actually behaves differently.
 * Returns null for an unfiled chat, a deleted playbook, or a deactivated one
 * (an inactive playbook is excluded from the prompt entirely, so focusing on it
 * would point the Engine at instructions it was never given).
 */
export async function getFocusPlaybookName(
  organizationId: string,
  playbookId: string
): Promise<string | null> {
  const playbook = await prisma.playbook.findFirst({
    where: { id: playbookId, organizationId, isActive: true },
    select: { name: true },
  });
  return playbook?.name ?? null;
}

export function formatPlaybooksForPrompt(playbooks: PlaybookForPrompt[]): string {
  if (playbooks.length === 0) return '';
  const blocks = playbooks
    .map((p) => {
      const channelNote = p.channel !== 'ALL' ? ` [${p.channel} channel only]` : '';
      const identity = p.identityLabel ? `\n${p.identityLabel}` : '';
      const transport = p.transportLabel ? `\n${p.transportLabel}` : '';
      return `### ${p.name}${channelNote}\n${p.scopeLabel}${identity}${transport}\n${p.instructions}`;
    })
    .join('\n\n');
  const anyIdentity = playbooks.some((p) => p.identityLabel);
  const identityNote = anyIdentity
    ? `\nSome playbooks carry a "Send as" identity — the person and business that outreach under them comes from. When a playbook matching your lead has one, write in that identity's voice, never another playbook's.\n${identityPrecedenceNote()}`
    : '';
  return `\n\n## Playbooks (protocols set by your team — FOLLOW THESE)\nWhen working a lead, apply every playbook whose scope matches it (group, campaign, or status). Channel-tagged playbooks apply only to that channel; VOICE playbooks define how phone calls should be conducted.\n${identityNote}\n${blocks}`;
}

/** Playbooks that shape a phone call: global voice ones plus matching scopes. */
export async function getVoicePlaybookText(organizationId: string): Promise<string> {
  const playbooks = await getActivePlaybooks(organizationId);
  const relevant = playbooks.filter((p) => p.channel === 'VOICE' || p.channel === 'ALL');
  if (relevant.length === 0) return '';
  return relevant
    .map((p) => `${p.name} (${p.scopeLabel}):\n${p.instructions}`)
    .join('\n\n');
}
