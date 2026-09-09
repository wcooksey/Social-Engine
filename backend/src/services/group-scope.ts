import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';

/** Group membership is not a campaign hierarchy: enrollment can span groups. */
export function campaignGroupWhere(groupId: string): Prisma.CampaignWhereInput {
  return { OR: [{ autoEnrollGroupId: groupId }, { campaignLeads: { some: { lead: { groupId } } } }] };
}
export function playbookGroupWhere(groupId: string): Prisma.PlaybookWhereInput {
  return { OR: [{ scope: 'GLOBAL' }, { scope: 'LEAD_STATUS' }, { scope: 'GROUP', groupId },
    { scope: 'CAMPAIGN', campaign: campaignGroupWhere(groupId) }] };
}
export async function requireGroup(organizationId: string, raw: unknown): Promise<string | undefined> {
  if (!raw) return undefined;
  const id = String(raw);
  const group = await prisma.leadGroup.findFirst({ where: { id, organizationId }, select: { id: true } });
  if (!group) throw new AppError('Group not found', 404);
  return group.id;
}
export async function requireCampaign(organizationId: string, raw: unknown, groupId?: string): Promise<string | undefined> {
  if (!raw) return undefined;
  const campaign = await prisma.campaign.findFirst({ where: { id: String(raw), organizationId,
    ...(groupId ? campaignGroupWhere(groupId) : {}) }, select: { id: true, sequenceEnabled: true } });
  if (!campaign) throw new AppError('Campaign not found in this workspace', 404);
  if (campaign.sequenceEnabled) throw new AppError('Fixed sequences use approved steps, not experiment variants. Use an AI cadence campaign for this experiment.');
  return campaign.id;
}

export async function experimentGroupWhere(organizationId: string, groupId: string): Promise<Prisma.ExperimentWhereInput> {
  const campaigns = await prisma.campaign.findMany({ where: { organizationId, ...campaignGroupWhere(groupId) }, select: { id: true } });
  return { OR: [{ groupId }, { groupId: null, campaignId: { in: campaigns.map(c => c.id) } }, { groupId: null, campaignId: null }] };
}
