import { Router } from 'express';
import { prisma } from '../config/database';
import { asyncHandler } from '../middleware/error.middleware';

const router = Router();

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;

    const [totalLeads, totalContacts, activeCampaigns, pendingJobs, byStatus, recentRuns, recentActivities] =
      await Promise.all([
        prisma.lead.count({ where: { organizationId } }),
        prisma.contact.count({ where: { organizationId } }),
        prisma.campaign.count({ where: { organizationId, status: 'ACTIVE' } }),
        prisma.agentJob.count({ where: { organizationId, status: 'PENDING' } }),
        prisma.lead.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: { _all: true },
        }),
        prisma.agentRun.findMany({
          where: { organizationId },
          orderBy: { startedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            trigger: true,
            objective: true,
            status: true,
            summary: true,
            startedAt: true,
            finishedAt: true,
          },
        }),
        prisma.activity.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { lead: { select: { id: true, companyName: true } } },
        }),
      ]);

    const leadsByStatus: Record<string, number> = {};
    for (const row of byStatus) leadsByStatus[row.status] = row._count._all;

    res.json({
      success: true,
      data: {
        totalLeads,
        totalContacts,
        activeCampaigns,
        pendingJobs,
        leadsByStatus,
        recentRuns,
        recentActivities,
      },
    });
  })
);

export default router;
