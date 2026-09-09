import { prisma } from '../config/database';

/** Multi-group campaign jobs stay aggregate; never turn their auto-enrollment target into a false owner. */
export async function resolveJobGroup(job: {
  organizationId: string;
  leadId: string | null;
  campaignId: string | null;
  playbookId: string | null;
  createdByRunId: string | null;
}): Promise<string | undefined> {
  if (job.leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: job.leadId, organizationId: job.organizationId }, select: { groupId: true } });
    return lead?.groupId ?? undefined;
  }
  if (job.campaignId) {
    const rows = await prisma.campaignLead.findMany({
      where: { campaignId: job.campaignId, campaign: { organizationId: job.organizationId } },
      select: { lead: { select: { groupId: true } } },
    });
    const groups = new Set(rows.map(row => row.lead.groupId));
    if (groups.size === 1) return [...groups][0] ?? undefined;
    return undefined;
  }
  const [playbook, creator] = await Promise.all([
    job.playbookId ? prisma.playbook.findFirst({ where: { id: job.playbookId, organizationId: job.organizationId }, select: { groupId: true } }) : null,
    job.createdByRunId ? prisma.agentRun.findFirst({ where: { id: job.createdByRunId, organizationId: job.organizationId }, select: { groupId: true } }) : null,
  ]);
  return playbook?.groupId ?? creator?.groupId ?? undefined;
}
