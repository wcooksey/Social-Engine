import { prisma } from '../config/database';

export interface PlaybookForPrompt {
  name: string;
  scopeLabel: string;
  channel: string;
  instructions: string;
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
    };
  });
}

export function formatPlaybooksForPrompt(playbooks: PlaybookForPrompt[]): string {
  if (playbooks.length === 0) return '';
  const blocks = playbooks
    .map((p) => {
      const channelNote = p.channel !== 'ALL' ? ` [${p.channel} channel only]` : '';
      return `### ${p.name}${channelNote}\n${p.scopeLabel}\n${p.instructions}`;
    })
    .join('\n\n');
  return `\n\n## Playbooks (protocols set by your team — FOLLOW THESE)\nWhen working a lead, apply every playbook whose scope matches it (group, campaign, or status). Channel-tagged playbooks apply only to that channel; VOICE playbooks define how phone calls should be conducted.\n\n${blocks}`;
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
