import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const [groups, tierRows, contactability, ungroupedCount] = await Promise.all([
      prisma.leadGroup.findMany({
        where: { organizationId },
        // Playbooks and coverage cells CASCADE when a group is deleted, unlike
        // leads which are merely unlinked. Counting them here is what lets the
        // delete confirmation say exactly what is about to be destroyed rather
        // than asking for a blind yes.
        include: { _count: { select: { leads: true, playbooks: true, coverageCells: true } } },
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
      // Leads that outlived their group. Deleting a group unlinks its leads
      // rather than destroying them, so without this number the orphans are
      // invisible while still inflating every total on the Leads page.
      prisma.lead.count({ where: { organizationId, groupId: null } }),
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
      data: {
        ungroupedLeads: ungroupedCount,
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          goal: g.goal,
          aiSummary: g.aiSummary,
          leadCount: g._count.leads,
          // What a delete would take with it — leads survive, these do not.
          playbookCount: g._count.playbooks,
          coverageCellCount: g._count.coverageCells,
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
      },
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

/**
 * Delete a group.
 *
 * By default the leads survive and become ungrouped — a list is a view over
 * leads, not their owner, and destroying hundreds of enriched businesses
 * because someone tidied a list would be the worse default by far.
 *
 * `?withLeads=true` is the other intent: the list was a mistake and the leads
 * should go with it. Both are legitimate; the difference just has to be a
 * choice rather than a surprise, because the "keep" branch silently grows an
 * invisible orphan pool that keeps every total looking unchanged.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const existing = await prisma.leadGroup.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw new AppError('Group not found', 404);

    const withLeads = req.query.withLeads === 'true';
    let deletedLeads = 0;

    if (withLeads) {
      // Before the group, so a failure here cannot leave leads orphaned with
      // the group already gone — the caller can simply retry.
      const removed = await prisma.lead.deleteMany({
        where: { organizationId, groupId: existing.id },
      });
      deletedLeads = removed.count;
    }

    await prisma.leadGroup.delete({ where: { id: existing.id } });

    const ungroupedLeads = await prisma.lead.count({ where: { organizationId, groupId: null } });
    res.json({ success: true, data: { deletedLeads, ungroupedLeads } });
  })
);

export default router;
