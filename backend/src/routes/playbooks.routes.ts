import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

const includeRelations = {
  group: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
} as const;

// Sender identity — all optional, blank clears the field back to the org default.
const IDENTITY_FIELDS = [
  'identityName',
  'identityOrgName',
  'identityTitle',
  'identityEmail',
  'identitySignature',
] as const;

/** Trimmed identity values from a request body; empty string means "clear". */
function identityData(body: Record<string, unknown>): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const key of IDENTITY_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    if (key === 'identityEmail' && value && !value.includes('@')) {
      throw new AppError('Reply-to must be a valid email address');
    }
    data[key] = value || null;
  }
  return data;
}

async function validateScopeTarget(
  body: Record<string, unknown>,
  organizationId: string
): Promise<void> {
  const scope = body.scope || 'GLOBAL';
  if (scope === 'GROUP') {
    if (!body.groupId) throw new AppError('groupId is required for GROUP scope');
    const group = await prisma.leadGroup.findFirst({
      where: { id: String(body.groupId), organizationId },
      select: { id: true },
    });
    if (!group) throw new AppError('Lead group not found', 404);
  }
  if (scope === 'CAMPAIGN') {
    if (!body.campaignId) throw new AppError('campaignId is required for CAMPAIGN scope');
    const campaign = await prisma.campaign.findFirst({
      where: { id: String(body.campaignId), organizationId },
      select: { id: true },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
  }
  if (scope === 'LEAD_STATUS' && !body.leadStatus)
    throw new AppError('leadStatus is required for LEAD_STATUS scope');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const playbooks = await prisma.playbook.findMany({
      where: { organizationId: req.user!.organizationId },
      include: includeRelations,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: playbooks });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    if (!req.body.instructions?.trim()) throw new AppError('instructions are required');
    await validateScopeTarget(req.body, req.user!.organizationId);

    const playbook = await prisma.playbook.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        scope: req.body.scope || 'GLOBAL',
        groupId: req.body.scope === 'GROUP' ? req.body.groupId : null,
        campaignId: req.body.scope === 'CAMPAIGN' ? req.body.campaignId : null,
        leadStatus: req.body.scope === 'LEAD_STATUS' ? req.body.leadStatus : null,
        channel: req.body.channel || 'ALL',
        instructions: req.body.instructions,
        isActive: req.body.isActive ?? true,
        priority: req.body.priority ?? 100,
        ...identityData(req.body),
      },
      include: includeRelations,
    });
    res.status(201).json({ success: true, data: playbook });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.playbook.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Playbook not found', 404);

    const data: Record<string, unknown> = { ...identityData(req.body) };
    for (const key of ['name', 'instructions', 'channel', 'isActive', 'priority'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    if ('scope' in req.body) {
      await validateScopeTarget({ ...req.body }, req.user!.organizationId);
      data.scope = req.body.scope;
      data.groupId = req.body.scope === 'GROUP' ? req.body.groupId : null;
      data.campaignId = req.body.scope === 'CAMPAIGN' ? req.body.campaignId : null;
      data.leadStatus = req.body.scope === 'LEAD_STATUS' ? req.body.leadStatus : null;
    }

    const playbook = await prisma.playbook.update({
      where: { id: existing.id },
      data,
      include: includeRelations,
    });
    res.json({ success: true, data: playbook });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.playbook.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Playbook not found', 404);
    await prisma.playbook.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
