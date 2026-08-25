import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware } from '../middleware/auth.middleware';

const router = Router();

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** A slug derived from `source` that no other organization is using. */
async function uniqueSlug(source: string, selfId: string): Promise<string> {
  const base = slugify(source) || 'org';
  const taken = await prisma.organization.findUnique({ where: { slug: base } });
  if (!taken || taken.id === selfId) return base;
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        engineModel: true,
        coachModel: true,
        dailySendCap: true,
        dailyAiSpendCapUsd: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        postalAddress: true,
        paused: true,
        socialAutonomy: true,
        createdAt: true,
      },
    });
    if (!org) throw new AppError('Organization not found', 404);
    res.json({ success: true, data: org });
  })
);

router.patch(
  '/mine',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const allowed = ['name', 'engineModel', 'coachModel', 'dailySendCap', 'quietHoursStart', 'quietHoursEnd', 'postalAddress', 'paused', 'socialAutonomy'] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }

    // Daily AI spend ceiling. Blank clears it back to no limit.
    if ('dailyAiSpendCapUsd' in req.body) {
      const raw = req.body.dailyAiSpendCapUsd;
      if (raw === null || raw === '' || raw === undefined) {
        data.dailyAiSpendCapUsd = null;
      } else {
        const amount = Number(raw);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new AppError('Daily AI spend cap must be a positive amount, or blank for no limit');
        }
        data.dailyAiSpendCapUsd = amount;
      }
    }

    if ('name' in req.body) {
      const name = String(req.body.name ?? '').trim();
      if (!name) throw new AppError('Organization name cannot be empty');
      data.name = name;
      // Keep the slug in step with the name. Nothing public is keyed off it
      // (booking links carry their own slug), so regenerating is safe.
      data.slug = await uniqueSlug(name, req.user!.organizationId);
    }

    const org = await prisma.organization.update({
      where: { id: req.user!.organizationId },
      data,
    });
    res.json({ success: true, data: org });
  })
);

export default router;
