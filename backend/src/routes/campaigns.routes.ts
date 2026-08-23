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

    // Re-engagement. Blank or null turns it off — one pass, then done.
    if ('reEngageAfterDays' in req.body) {
      const raw = req.body.reEngageAfterDays;
      if (raw === null || raw === '') {
        data.reEngageAfterDays = null;
      } else {
        const days = Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > 730) {
          throw new AppError('Re-engage after must be between 1 and 730 days, or blank for never');
        }
        data.reEngageAfterDays = days;
      }
    }
    if ('maxCycles' in req.body) {
      const cycles = Number(req.body.maxCycles);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > 12) {
        throw new AppError('Total passes must be between 1 and 12');
      }
      data.maxCycles = cycles;
    }

    const campaign = await prisma.campaign.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: campaign });
  })
);

/**
 * What this campaign is about to do — the next fortnight of scheduled touches,
 * with enough context to judge and change each one.
 */
router.get(
  '/:id/schedule',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
    const horizon = new Date(Date.now() + days * 24 * 3600 * 1000);

    const [upcoming, cycles, dormantCount] = await Promise.all([
      prisma.campaignLead.findMany({
        where: {
          campaignId: campaign.id,
          status: { in: ['PENDING', 'IN_SEQUENCE'] },
          OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: horizon } }],
        },
        orderBy: [{ nextTouchAt: 'asc' }, { createdAt: 'asc' }],
        take: 200,
        include: {
          lead: {
            select: {
              id: true,
              companyName: true,
              city: true,
              status: true,
              doNotContact: true,
              contactReviewReason: true,
            },
          },
        },
      }),
      prisma.campaignCycle.findMany({ where: { campaignId: campaign.id }, orderBy: { cycle: 'asc' } }),
      prisma.campaignLead.count({ where: { campaignId: campaign.id, status: 'COMPLETED' } }),
    ]);

    res.json({
      success: true,
      data: {
        days,
        reEngageAfterDays: campaign.reEngageAfterDays,
        maxCycles: campaign.maxCycles,
        followUpCadenceDays: campaign.followUpCadenceDays,
        maxTouches: campaign.maxTouches,
        // Leads resting between passes — the pool re-engagement will draw from.
        dormantCount,
        cycles,
        upcoming: upcoming.map((cl) => ({
          id: cl.id,
          leadId: cl.leadId,
          companyName: cl.lead.companyName,
          city: cl.lead.city,
          leadStatus: cl.lead.status,
          sequenceStatus: cl.status,
          touchCount: cl.touchCount,
          cycle: cl.cycle,
          nextTouchAt: cl.nextTouchAt,
          lastTouchAt: cl.lastTouchAt,
          // Surfaced so the list explains itself rather than silently skipping.
          blocked: cl.lead.doNotContact
            ? 'Lead has opted out'
            : cl.lead.contactReviewReason
              ? 'On hold pending an ownership check'
              : null,
        })),
      },
    });
  })
);

/** Reschedule or remove one lead's next touch, from the schedule view. */
router.patch(
  '/:id/schedule/:campaignLeadId',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const row = await prisma.campaignLead.findFirst({
      where: { id: req.params.campaignLeadId, campaignId: campaign.id },
    });
    if (!row) throw new AppError('Lead is not enrolled in this campaign', 404);

    const data: Record<string, unknown> = {};
    if ('nextTouchAt' in req.body) {
      const raw = req.body.nextTouchAt;
      if (raw === null || raw === '') {
        // Null means "due now" to the cadence sweep.
        data.nextTouchAt = null;
      } else {
        const when = new Date(String(raw));
        if (Number.isNaN(when.getTime())) throw new AppError('nextTouchAt must be a date');
        data.nextTouchAt = when;
      }
    }
    if ('status' in req.body) {
      const allowed = ['PENDING', 'IN_SEQUENCE', 'COMPLETED', 'REMOVED'];
      const status = String(req.body.status);
      if (!allowed.includes(status)) throw new AppError(`status must be one of ${allowed.join(', ')}`);
      data.status = status;
      // Taking a lead out by hand should not leave it eligible for the
      // re-engagement sweep to pull straight back in.
      if (status === 'REMOVED' || status === 'COMPLETED') data.dormantSince = null;
    }
    if (Object.keys(data).length === 0) throw new AppError('Nothing to change');

    const updated = await prisma.campaignLead.update({ where: { id: row.id }, data });
    res.json({ success: true, data: updated });
  })
);

/** Create or edit the angle a given cycle leads with. */
router.put(
  '/:id/cycles/:cycle',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const cycle = parseInt(req.params.cycle, 10);
    if (!Number.isInteger(cycle) || cycle < 2 || cycle > 12) {
      throw new AppError('Cycle must be between 2 and 12 — the first pass uses the campaign offer');
    }
    const angle = String(req.body?.angle ?? '').trim();
    if (!angle) throw new AppError('angle is required — what is new this time round?');

    const saved = await prisma.campaignCycle.upsert({
      where: { campaignId_cycle: { campaignId: campaign.id, cycle } },
      create: { campaignId: campaign.id, cycle, angle },
      update: { angle },
    });
    res.json({ success: true, data: saved });
  })
);

router.delete(
  '/:id/cycles/:cycle',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
    await prisma.campaignCycle.deleteMany({
      where: { campaignId: campaign.id, cycle: parseInt(req.params.cycle, 10) },
    });
    res.json({ success: true, data: null });
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
