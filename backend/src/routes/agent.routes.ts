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
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
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

/**
 * AI usage & estimated cost, aggregated for the org: totals, per-model, and
 * per-day over the requested window (?days=30, max 365). Costs are estimates
 * at list prices — the provider's invoice is the source of truth.
 */
router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt((req.query.days as string) || '30', 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const where = { organizationId: req.user!.organizationId, startedAt: { gte: since } };

    const [totals, byModelRaw, runs] = await Promise.all([
      prisma.agentRun.aggregate({
        where,
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _count: true,
      }),
      prisma.agentRun.groupBy({
        by: ['model'],
        where,
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _count: true,
      }),
      prisma.agentRun.findMany({
        where,
        select: { startedAt: true, inputTokens: true, outputTokens: true, costUsd: true },
      }),
    ]);

    // Per-day rollup (UTC days) for the trend line.
    const byDayMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; runs: number }>();
    for (const r of runs) {
      const day = r.startedAt.toISOString().slice(0, 10);
      const entry = byDayMap.get(day) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
      entry.inputTokens += r.inputTokens;
      entry.outputTokens += r.outputTokens;
      entry.costUsd += r.costUsd;
      entry.runs += 1;
      byDayMap.set(day, entry);
    }

    res.json({
      success: true,
      data: {
        days,
        totals: {
          runs: totals._count,
          inputTokens: totals._sum.inputTokens ?? 0,
          outputTokens: totals._sum.outputTokens ?? 0,
          costUsd: totals._sum.costUsd ?? 0,
        },
        byModel: byModelRaw
          .map((m) => ({
            model: m.model ?? 'unknown',
            runs: m._count,
            inputTokens: m._sum.inputTokens ?? 0,
            outputTokens: m._sum.outputTokens ?? 0,
            costUsd: m._sum.costUsd ?? 0,
          }))
          .sort((a, b) => b.costUsd - a.costUsd),
        byDay: [...byDayMap.entries()]
          .map(([day, v]) => ({ day, ...v }))
          .sort((a, b) => a.day.localeCompare(b.day)),
        note: 'Estimated at list prices per token; provider invoices are authoritative.',
      },
    });
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
