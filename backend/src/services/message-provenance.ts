import { prisma } from '../config/database';
export async function messageProvenance(input: { organizationId: string; leadId: string; source: 'engine' | 'sequence'; runId?: string; playbookId?: string; routingPlaybookId?: string; stepId?: string; variantId?: string }) {
  const [lead, playbooks] = await Promise.all([
    prisma.lead.findFirst({ where: { id: input.leadId, organizationId: input.organizationId }, select: { group: { select: { id: true, name: true } } } }),
    prisma.playbook.findMany({ where: { organizationId: input.organizationId, id: { in: [input.playbookId, input.routingPlaybookId].filter((id): id is string => !!id) } }, select: { id: true, name: true } })
  ]);
  return { source: input.source, runId: input.runId ?? null, groupId: lead?.group?.id ?? null, groupName: lead?.group?.name ?? null,
    playbookId: input.playbookId ?? null, playbookName: playbooks.find(p => p.id === input.playbookId)?.name ?? null,
    routingPlaybookId: input.routingPlaybookId ?? null, routingPlaybookName: playbooks.find(p => p.id === input.routingPlaybookId)?.name ?? null, stepId: input.stepId ?? null,
    reason: input.source === 'sequence' ? 'Approved fixed sequence step; experiment variants are not used by this path.' : input.variantId ? 'Engine composed this message using the selected experiment variant.' : 'Engine composed this message from the run objective and applicable playbooks. Detailed selection rationale was not recorded.' };
}
