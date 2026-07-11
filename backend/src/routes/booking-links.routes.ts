import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware } from '../middleware/auth.middleware';
import { config } from '../config/environment';

const router = Router();

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const DEFAULT_AVAILABILITY = {
  '1': [['09:00', '17:00']],
  '2': [['09:00', '17:00']],
  '3': [['09:00', '17:00']],
  '4': [['09:00', '17:00']],
  '5': [['09:00', '17:00']],
};

function publicUrl(slug: string): string {
  return `${config.appPublicUrl}/book/${slug}`;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const links = await prisma.bookingLink.findMany({
      where: { organizationId: req.user!.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: links.map((l) => ({ ...l, url: publicUrl(l.slug) })),
    });
  })
);

router.post(
  '/',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const title = String(req.body?.title || '').trim();
    if (!title) throw new AppError('title is required');

    let slug = slugify(req.body?.slug || title) || 'meet';
    // Ensure global uniqueness (slug is the public URL).
    if (await prisma.bookingLink.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    }

    const link = await prisma.bookingLink.create({
      data: {
        organizationId: req.user!.organizationId,
        slug,
        title,
        description: req.body?.description || null,
        durationMinutes: Number(req.body?.durationMinutes) || 30,
        bufferMinutes: Number(req.body?.bufferMinutes) || 0,
        timezone: req.body?.timezone || 'America/New_York',
        availability: req.body?.availability || DEFAULT_AVAILABILITY,
        active: req.body?.active ?? true,
      },
    });
    res.status(201).json({ success: true, data: { ...link, url: publicUrl(link.slug) } });
  })
);

router.patch(
  '/:id',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.bookingLink.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Booking link not found', 404);

    const data: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'durationMinutes', 'bufferMinutes', 'timezone', 'availability', 'active'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    const link = await prisma.bookingLink.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: { ...link, url: publicUrl(link.slug) } });
  })
);

router.delete(
  '/:id',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.bookingLink.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Booking link not found', 404);
    await prisma.bookingLink.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
