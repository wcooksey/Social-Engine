import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

const includeRelations = {
  group: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
} as const;

function validateScopeTarget(body: Record<string, unknown>): void {
  const scope = body.scope || 'GLOBAL';
  if (scope === 'GROUP' && !body.groupId) throw new AppError('groupId is required for GROUP scope');
  if (scope === 'CAMPAIGN' && !body.campaignId)
    throw new AppError('campaignId is required for CAMPAIGN scope');
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
    validateScopeTarget(req.body);

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

    const data: Record<string, unknown> = {};
    for (const key of ['name', 'instructions', 'channel', 'isActive', 'priority'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    if ('scope' in req.body) {
      validateScopeTarget({ ...req.body });
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
