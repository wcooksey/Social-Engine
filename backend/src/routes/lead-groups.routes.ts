import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const [groups, tierRows, contactability] = await Promise.all([
      prisma.leadGroup.findMany({
        where: { organizationId },
        include: { _count: { select: { leads: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      // One grouped query for every group's tier mix, instead of N per-group counts.
      prisma.lead.groupBy({
        by: ['groupId', 'enrichmentTier'],
        where: { organizationId, groupId: { not: null } },
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ['groupId'],
        where: { organizationId, groupId: { not: null } },
        _count: { _all: true },
        _avg: { enrichmentScore: true },
        _sum: { emailCount: true },
      }),
    ]);

    const withEmail = await prisma.lead.groupBy({
      by: ['groupId'],
      where: { organizationId, groupId: { not: null }, emailCount: { gt: 0 } },
      _count: { _all: true },
    });
    const emailReady = new Map(withEmail.map((r) => [r.groupId, r._count._all]));
    const averages = new Map(contactability.map((r) => [r.groupId, Math.round(r._avg.enrichmentScore || 0)]));
    const tiersByGroup = new Map<string, Record<string, number>>();
    for (const row of tierRows) {
      if (!row.groupId) continue;
      const bucket = tiersByGroup.get(row.groupId) || {};
      bucket[row.enrichmentTier] = row._count._all;
      tiersByGroup.set(row.groupId, bucket);
    }

    res.json({
      success: true,
      data: groups.map((g) => ({
        id: g.id,
        name: g.name,
        goal: g.goal,
        aiSummary: g.aiSummary,
        leadCount: g._count.leads,
        createdAt: g.createdAt,
        // At-a-glance list quality: how much of this group is actually workable.
        enrichment: {
          averageScore: averages.get(g.id) || 0,
          withEmail: emailReady.get(g.id) || 0,
          tiers: {
            NONE: 0,
            MINIMAL: 0,
            PARTIAL: 0,
            GOOD: 0,
            RICH: 0,
            ...(tiersByGroup.get(g.id) || {}),
          },
        },
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
