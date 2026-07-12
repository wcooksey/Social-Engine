import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

function serialize(c: { _count?: { campaignLeads: number } } & Record<string, unknown>) {
  const { _count, ...rest } = c;
  return { ...rest, leadCount: _count?.campaignLeads ?? 0 };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const campaigns = await prisma.campaign.findMany({
      where: { organizationId: req.user!.organizationId },
      include: { _count: { select: { campaignLeads: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: campaigns.map(serialize) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        offer: req.body.offer || null,
        channels: req.body.channels || ['EMAIL'],
        mode: req.body.mode || 'APPROVAL_REQUIRED',
        followUpCadenceDays: req.body.followUpCadenceDays ?? 3,
        maxTouches: req.body.maxTouches ?? 6,
      },
    });
    res.status(201).json({ success: true, data: { ...campaign, leadCount: 0 } });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      include: {
        _count: { select: { campaignLeads: true } },
        autoEnrollGroup: { select: { id: true, name: true } },
        campaignLeads: {
          include: {
            lead: {
              select: {
                id: true,
                companyName: true,
                status: true,
                city: true,
                state: true,
                doNotContact: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        },
      },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
    res.json({ success: true, data: serialize(campaign as never) });
  })
);

/** Everything that has happened on this campaign, newest first (paginated). */
router.get(
  '/:id/activity',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      select: { id: true },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = 25;
    const where = { campaignId: campaign.id };
    const [activities, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { lead: { select: { id: true, companyName: true } } },
      }),
      prisma.activity.count({ where }),
    ]);
    res.json({ success: true, data: { activities, total, page, pageSize } });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Campaign not found', 404);

    const allowed = ['name', 'offer', 'channels', 'mode', 'status', 'followUpCadenceDays', 'maxTouches'] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    const campaign = await prisma.campaign.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: campaign });
  })
);

router.post(
  '/:id/leads',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const leadIds: string[] = req.body.leadIds || [];
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, organizationId: req.user!.organizationId },
      select: { id: true },
    });
    const result = await prisma.campaignLead.createMany({
      data: leads.map((l) => ({ campaignId: campaign.id, leadId: l.id })),
      skipDuplicates: true,
    });
    res.json({ success: true, data: { added: result.count } });
  })
);

export default router;
