import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

router.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = 25;
    const where = { organizationId: req.user!.organizationId };
    const [runs, total] = await Promise.all([
      prisma.agentRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { steps: true } } },
      }),
      prisma.agentRun.count({ where }),
    ]);
    res.json({
      success: true,
      data: {
        runs: runs.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          role: r.role,
          objective: r.objective,
          status: r.status,
          summary: r.summary,
          error: r.error,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          stepCount: r._count.steps,
        })),
        total,
        page,
        pageSize,
      },
    });
  })
);

router.get(
  '/runs/:id',
  asyncHandler(async (req, res) => {
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      include: { steps: { orderBy: { index: 'asc' } } },
    });
    if (!run) throw new AppError('Run not found', 404);
    res.json({ success: true, data: run });
  })
);

router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const jobs = await prisma.agentJob.findMany({
      where: {
        organizationId: req.user!.organizationId,
        ...(req.query.status ? { status: req.query.status as never } : {}),
      },
      orderBy: { runAt: 'asc' },
      take: 100,
      include: {
        lead: { select: { id: true, companyName: true } },
        campaign: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, data: jobs });
  })
);

router.post(
  '/jobs/:id/cancel',
  asyncHandler(async (req, res) => {
    const job = await prisma.agentJob.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!job) throw new AppError('Job not found', 404);
    if (job.status !== 'PENDING') throw new AppError('Only pending jobs can be cancelled');
    const updated = await prisma.agentJob.update({
      where: { id: job.id },
      data: { status: 'CANCELLED' },
    });
    res.json({ success: true, data: updated });
  })
);

export default router;
