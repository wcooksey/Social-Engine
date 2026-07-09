import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { leadService } from '../services/lead.service';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await leadService.searchLeads(req.user!.organizationId, {
      search: req.query.search as string,
      status: req.query.status as string,
      groupId: req.query.groupId as string,
      state: req.query.state as string,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
    });
    res.json({ success: true, data });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { lead, created } = await leadService.upsertLead(req.user!.organizationId, {
      ...req.body,
      source: req.body.source || 'manual',
    });
    res.status(created ? 201 : 200).json({ success: true, data: lead });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      include: {
        group: { select: { id: true, name: true } },
        contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        activities: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!lead) throw new AppError('Lead not found', 404);
    res.json({ success: true, data: lead });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.lead.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Lead not found', 404);

    const allowed = [
      'companyName',
      'website',
      'phone',
      'address',
      'city',
      'state',
      'postalCode',
      'country',
      'industry',
      'status',
      'groupId',
      'aiSummary',
      'socials',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }

    const lead = await prisma.lead.update({ where: { id: existing.id }, data });

    if (data.status && data.status !== existing.status) {
      await leadService.logActivity({
        organizationId: existing.organizationId,
        leadId: existing.id,
        type: 'STATUS_CHANGE',
        summary: `Status changed from ${existing.status} to ${data.status}`,
      });
    }
    res.json({ success: true, data: lead });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.lead.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Lead not found', 404);
    await prisma.lead.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

router.post(
  '/:id/contacts',
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!lead) throw new AppError('Lead not found', 404);

    const contact = await prisma.contact.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        title: req.body.title,
        email: req.body.email?.toLowerCase().trim() || null,
        phone: req.body.phone,
        socials: req.body.socials,
        source: req.body.source || 'manual',
        isPrimary: !!req.body.isPrimary,
      },
    });
    res.status(201).json({ success: true, data: contact });
  })
);

export default router;
