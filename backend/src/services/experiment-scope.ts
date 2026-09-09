export function experimentScopeError(experiment: { organizationId: string; channel: string; groupId: string | null; campaignId: string | null; status: string }, context: { organizationId: string; channel: string; groupId: string | null; campaignId?: string }): string | null {
  if (experiment.organizationId !== context.organizationId) return 'Experiment belongs to another organization.';
  if (experiment.status !== 'ACTIVE') return 'Experiment is not active.';
  if (experiment.channel !== context.channel) return 'Experiment channel does not match this send.';
  if (experiment.groupId && experiment.groupId !== context.groupId) return 'Experiment belongs to another group.';
  if (experiment.campaignId && experiment.campaignId !== context.campaignId) return 'Experiment belongs to another campaign.';
  return null;
}
