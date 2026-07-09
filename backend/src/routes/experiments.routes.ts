import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { getExperimentResults, summarizeVariant } from '../services/experiment.service';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const experiments = await prisma.experiment.findMany({
      where: { organizationId: req.user!.organizationId },
      include: { variants: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: experiments.map((e) => ({
        id: e.id,
        name: e.name,
        channel: e.channel,
        goal: e.goal,
        status: e.status,
        winnerVariantId: e.winnerVariantId,
        createdAt: e.createdAt,
        variants: e.variants.map(summarizeVariant),
      })),
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    const variants: { label: string; content: string; weight?: number }[] = req.body.variants || [];
    if (variants.length < 2) throw new AppError('Provide at least 2 variants to split test');

    const experiment = await prisma.experiment.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        channel: req.body.channel || 'EMAIL',
        goal: req.body.goal || null,
        campaignId: req.body.campaignId || null,
        variants: {
          create: variants.map((v) => ({
            label: v.label,
            content: v.content,
            weight: v.weight ?? 1,
          })),
        },
      },
      include: { variants: true },
    });
    res.status(201).json({ success: true, data: experiment });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const results = await getExperimentResults(req.params.id, req.user!.organizationId);
    if (!results) throw new AppError('Experiment not found', 404);
    res.json({ success: true, data: results });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.experiment.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Experiment not found', 404);
    const data: Record<string, unknown> = {};
    for (const key of ['name', 'goal', 'status', 'winnerVariantId'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    const experiment = await prisma.experiment.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: experiment });
  })
);

export default router;
