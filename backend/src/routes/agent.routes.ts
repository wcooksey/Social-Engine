import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { browserActiveRunIds, getFrameImage, getLiveEntry } from '../engine/live-view.registry';

const router = Router();

/**
 * Mission control: everything currently running, with each run's latest steps
 * and whether it has a live browser to watch. The UI polls this every few
 * seconds — steps persist as they happen, so polling IS the live feed.
 */
router.get(
  '/live',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const runs = await prisma.agentRun.findMany({
      where: { organizationId, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      take: 25,
      include: {
        steps: { orderBy: { index: 'desc' }, take: 8 },
      },
    });
    const withBrowser = new Set(
      browserActiveRunIds(
        runs.map((r) => r.id),
        organizationId
      )
    );
    const [pendingJobs, recentFinished] = await Promise.all([
      prisma.agentJob.count({ where: { organizationId, status: 'PENDING', runAt: { lte: new Date() } } }),
      prisma.agentRun.findMany({
        where: { organizationId, status: { in: ['COMPLETED', 'FAILED'] } },
        orderBy: { finishedAt: 'desc' },
        take: 5,
        select: { id: true, role: true, objective: true, status: true, summary: true, finishedAt: true, costUsd: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        running: runs.map((r) => {
          const live = withBrowser.has(r.id) ? getLiveEntry(r.id, organizationId) : null;
          return {
            id: r.id,
            role: r.role,
            trigger: r.trigger,
            objective: r.objective,
            model: r.model,
            startedAt: r.startedAt,
            costUsd: r.costUsd,
            // steps come newest-first from the query; show oldest-first
            steps: [...r.steps].reverse().map((s) => ({
              index: s.index,
              type: s.type,
              toolName: s.toolName,
              // trim payloads — the live feed needs gist, not full dumps
              input: s.input ? JSON.stringify(s.input).slice(0, 200) : null,
              output: s.output ? JSON.stringify(s.output).slice(0, 200) : null,
              createdAt: s.createdAt,
            })),
            browser: live
              ? {
                  hasFrame: live.hasFrame,
                  frameAt: live.frameAt,
                  frameUrl: live.frameUrl,
                  frameAction: live.frameAction,
                  actions: live.actions.slice(-8),
                }
              : null,
          };
        }),
        queuedJobs: pendingJobs,
        recentFinished,
      },
    });
  })
);

/** Latest browser frame for a running run (JPEG base64 + metadata). */
router.get(
  '/live/:runId/frame',
  asyncHandler(async (req, res) => {
    const frame = getFrameImage(req.params.runId, req.user!.organizationId);
    if (!frame) throw new AppError('No live browser frame for this run', 404);
    res.json({
      success: true,
      data: { imageBase64: frame.imageBase64, url: frame.url, action: frame.action, at: frame.at },
    });
  })
);

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

/** Standing Autopilot goals — the mechanically re-queued objectives. */
router.get(
  '/goals',
  asyncHandler(async (req, res) => {
    const goals = await prisma.autopilotGoal.findMany({
      where: { organizationId: req.user!.organizationId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        leadGroup: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, data: goals });
  })
);

router.patch(
  '/goals/:id',
  asyncHandler(async (req, res) => {
    const goal = await prisma.autopilotGoal.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!goal) throw new AppError('Goal not found', 404);
    const status = req.body?.status as string | undefined;
    if (!status || !['ACTIVE', 'PAUSED', 'CANCELLED'].includes(status)) {
      throw new AppError('status must be ACTIVE, PAUSED, or CANCELLED');
    }
    const updated = await prisma.autopilotGoal.update({
      where: { id: goal.id },
      data: {
        status: status as never,
        // Resuming shouldn't wait out a stale clock.
        ...(status === 'ACTIVE' ? { nextRunAt: new Date() } : {}),
      },
    });
    res.json({ success: true, data: updated });
  })
);

export default router;
