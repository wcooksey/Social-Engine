import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groups = await prisma.leadGroup.findMany({
      where: { organizationId: req.user!.organizationId },
      include: { _count: { select: { leads: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: groups.map((g) => ({
        id: g.id,
        name: g.name,
        goal: g.goal,
        aiSummary: g.aiSummary,
        leadCount: g._count.leads,
        createdAt: g.createdAt,
      })),
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    const group = await prisma.leadGroup.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        goal: req.body.goal || null,
      },
    });
    res.status(201).json({ success: true, data: group });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.leadGroup.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Group not found', 404);
    const group = await prisma.leadGroup.update({
      where: { id: existing.id },
      data: {
        ...(req.body.name ? { name: req.body.name.trim() } : {}),
        ...('goal' in req.body ? { goal: req.body.goal } : {}),
      },
    });
    res.json({ success: true, data: group });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.leadGroup.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Group not found', 404);
    await prisma.leadGroup.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
