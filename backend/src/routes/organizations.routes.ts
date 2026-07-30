import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware } from '../middleware/auth.middleware';

const router = Router();

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
        quietHoursStart: true,
        quietHoursEnd: true,
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
    const allowed = ['name', 'engineModel', 'coachModel', 'dailySendCap', 'quietHoursStart', 'quietHoursEnd', 'paused', 'socialAutonomy'] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    const org = await prisma.organization.update({
      where: { id: req.user!.organizationId },
      data,
    });
    res.json({ success: true, data: org });
  })
);

export default router;
