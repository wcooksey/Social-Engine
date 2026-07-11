import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

const includeRelations = {
  lead: { select: { id: true, companyName: true } },
  contact: { select: { id: true, firstName: true, lastName: true } },
} as const;

function parseDate(value: unknown, field: string): Date {
  const date = new Date(String(value));
  if (isNaN(date.getTime())) throw new AppError(`Invalid ${field}`);
  return date;
}

async function assertOrgOwned(
  model: 'lead' | 'contact',
  id: unknown,
  organizationId: string
): Promise<void> {
  if (!id) return;
  const found =
    model === 'lead'
      ? await prisma.lead.findFirst({ where: { id: String(id), organizationId }, select: { id: true } })
      : await prisma.contact.findFirst({ where: { id: String(id), organizationId }, select: { id: true } });
  if (!found) throw new AppError(`${model === 'lead' ? 'Lead' : 'Contact'} not found`, 404);
}

router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const where: Record<string, unknown> = { organizationId: req.user!.organizationId };
    if (req.query.start || req.query.end) {
      where.startAt = {
        ...(req.query.start ? { gte: parseDate(req.query.start, 'start') } : {}),
        ...(req.query.end ? { lte: parseDate(req.query.end, 'end') } : {}),
      };
    }
    if (req.query.leadId) where.leadId = req.query.leadId;

    const events = await prisma.calendarEvent.findMany({
      where: where as never,
      include: includeRelations,
      orderBy: { startAt: 'asc' },
      take: 500,
    });
    res.json({ success: true, data: events });
  })
);

router.post(
  '/events',
  asyncHandler(async (req, res) => {
    if (!req.body.title?.trim()) throw new AppError('title is required');
    const startAt = parseDate(req.body.startAt, 'startAt');

    await assertOrgOwned('lead', req.body.leadId, req.user!.organizationId);
    await assertOrgOwned('contact', req.body.contactId, req.user!.organizationId);

    const event = await prisma.calendarEvent.create({
      data: {
        organizationId: req.user!.organizationId,
        title: req.body.title.trim(),
        description: req.body.description || null,
        location: req.body.location || null,
        type: req.body.type || 'MEETING',
        startAt,
        endAt: req.body.endAt ? parseDate(req.body.endAt, 'endAt') : null,
        allDay: !!req.body.allDay,
        leadId: req.body.leadId || null,
        contactId: req.body.contactId || null,
      },
      include: includeRelations,
    });
    res.status(201).json({ success: true, data: event });
  })
);

router.patch(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.calendarEvent.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Event not found', 404);

    await assertOrgOwned('lead', req.body.leadId, req.user!.organizationId);
    await assertOrgOwned('contact', req.body.contactId, req.user!.organizationId);

    const data: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'location', 'type', 'status', 'allDay', 'leadId', 'contactId'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    if ('startAt' in req.body) data.startAt = parseDate(req.body.startAt, 'startAt');
    if ('endAt' in req.body) data.endAt = req.body.endAt ? parseDate(req.body.endAt, 'endAt') : null;

    const event = await prisma.calendarEvent.update({
      where: { id: existing.id },
      data,
      include: includeRelations,
    });
    res.json({ success: true, data: event });
  })
);

router.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.calendarEvent.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Event not found', 404);
    await prisma.calendarEvent.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
