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

/**
 * Funnel: sourced → has contact info → contacted → replied → interested →
 * meeting booked → meeting completed. Optional ?campaignId= scopes every stage
 * to leads enrolled in that campaign. Powers the dashboard funnel view so you
 * can see where leads stall and tune playbooks/experiments accordingly.
 */
router.get(
  '/funnel',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const campaignId = (req.query.campaignId as string) || undefined;
    const inCampaign = campaignId ? { campaignLeads: { some: { campaignId } } } : {};
    const leadWhere = { organizationId, ...inCampaign };

    const [sourced, withContactInfo, contacted, replied, interested, booked, completedMeetings] =
      await Promise.all([
        prisma.lead.count({ where: leadWhere }),
        prisma.lead.count({
          where: {
            ...leadWhere,
            contacts: { some: { OR: [{ email: { not: null } }, { phone: { not: null } }] } },
          },
        }),
        prisma.lead.count({
          where: {
            ...leadWhere,
            activities: {
              some: { type: { in: ['EMAIL_SENT', 'SMS_SENT', 'CALL_PLACED', 'SOCIAL_TOUCH'] } },
            },
          },
        }),
        prisma.lead.count({
          where: {
            ...leadWhere,
            activities: { some: { type: { in: ['EMAIL_REPLY', 'SMS_REPLY'] } } },
          },
        }),
        prisma.lead.count({
          where: { ...leadWhere, status: { in: ['INTERESTED', 'CUSTOMER'] } },
        }),
        prisma.lead.count({
          where: { ...leadWhere, calendarEvents: { some: { status: { not: 'CANCELLED' } } } },
        }),
        prisma.lead.count({
          where: { ...leadWhere, calendarEvents: { some: { status: 'COMPLETED' } } },
        }),
      ]);

    res.json({
      success: true,
      data: {
        funnel: [
          { stage: 'Sourced', count: sourced },
          { stage: 'Has contact info', count: withContactInfo },
          { stage: 'Contacted', count: contacted },
          { stage: 'Replied', count: replied },
          { stage: 'Interested', count: interested },
          { stage: 'Meeting booked', count: booked },
          { stage: 'Meeting completed', count: completedMeetings },
        ],
        campaignId: campaignId ?? null,
      },
    });
  })
);

export default router;
