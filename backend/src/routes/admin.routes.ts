import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { superAdminMiddleware } from '../middleware/auth.middleware';
import { isSuperAdmin } from '../services/settings.service';
import { authService } from '../services/auth.service';

/**
 * Cross-organization operator surface for the single super-admin account. Every
 * route here reads or writes data belonging to *other* tenants, so the whole
 * router sits behind superAdminMiddleware — there is deliberately no per-route
 * opt-out. Secrets (org integration keys, social sessions, password hashes) are
 * never returned; this is an operations view, not an impersonation tool.
 */
const router = Router();
router.use(superAdminMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [organizations, users, leads, activeJobs, runsThisWeek, spendThisWeek, runningNow] =
      await Promise.all([
        prisma.organization.count(),
        prisma.user.count(),
        prisma.lead.count(),
        prisma.agentJob.count({ where: { status: 'PENDING' } }),
        prisma.agentRun.count({ where: { startedAt: { gte: since } } }),
        prisma.agentRun.aggregate({
          where: { startedAt: { gte: since } },
          _sum: { costUsd: true },
        }),
        prisma.agentRun.count({ where: { status: 'RUNNING' } }),
      ]);

    res.json({
      success: true,
      data: {
        organizations,
        users,
        leads,
        activeJobs,
        runningNow,
        runsThisWeek,
        spendThisWeekUsd: Number((spendThisWeek._sum.costUsd || 0).toFixed(2)),
      },
    });
  })
);

router.get(
  '/organizations',
  asyncHandler(async (_req, res) => {
    const orgs = await prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        engineModel: true,
        paused: true,
        dailySendCap: true,
        socialAutonomy: true,
        _count: { select: { users: true, leads: true, campaigns: true } },
      },
    });

    // Last activity + 7-day spend per org, in two grouped queries rather than
    // one per organization.
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [lastRuns, spend] = await Promise.all([
      prisma.agentRun.groupBy({ by: ['organizationId'], _max: { startedAt: true } }),
      prisma.agentRun.groupBy({
        by: ['organizationId'],
        where: { startedAt: { gte: since } },
        _sum: { costUsd: true },
      }),
    ]);
    const lastRunBy = new Map(lastRuns.map((r) => [r.organizationId, r._max.startedAt]));
    const spendBy = new Map(spend.map((r) => [r.organizationId, r._sum.costUsd || 0]));

    res.json({
      success: true,
      data: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        createdAt: o.createdAt,
        engineModel: o.engineModel,
        paused: o.paused,
        dailySendCap: o.dailySendCap,
        socialAutonomy: o.socialAutonomy,
        userCount: o._count.users,
        leadCount: o._count.leads,
        campaignCount: o._count.campaigns,
        lastRunAt: lastRunBy.get(o.id) ?? null,
        spendThisWeekUsd: Number((spendBy.get(o.id) || 0).toFixed(2)),
      })),
    });
  })
);

// Operator levers on someone else's org. Deliberately limited to the safety
// controls — no editing their data, keys, or integrations from here.
router.patch(
  '/organizations/:id',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id } });
    if (!org) throw new AppError('Organization not found', 404);

    const data: Record<string, unknown> = {};
    if ('paused' in req.body) data.paused = !!req.body.paused;
    if ('socialAutonomy' in req.body) data.socialAutonomy = !!req.body.socialAutonomy;
    if ('dailySendCap' in req.body) {
      const cap = Number(req.body.dailySendCap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 100000) {
        throw new AppError('Daily send cap must be between 0 and 100000');
      }
      data.dailySendCap = cap;
    }
    if (Object.keys(data).length === 0) throw new AppError('Nothing to update');

    const updated = await prisma.organization.update({ where: { id: org.id }, data });
    res.json({
      success: true,
      data: {
        id: updated.id,
        paused: updated.paused,
        dailySendCap: updated.dailySendCap,
        socialAutonomy: updated.socialAutonomy,
      },
    });
  })
);

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const users = await prisma.user.findMany({
      where: search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        organization: { select: { id: true, name: true } },
      },
    });
    res.json({
      success: true,
      data: users.map((u) => ({ ...u, isSuperAdmin: isSuperAdmin(u.email) })),
    });
  })
);

// Suspend/restore an account or change its role. Deactivating also revokes
// issued tokens so the user is out immediately, not at access-token expiry.
router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw new AppError('User not found', 404);

    const data: Record<string, unknown> = {};

    if ('isActive' in req.body) {
      const isActive = !!req.body.isActive;
      if (!isActive && isSuperAdmin(user.email)) {
        throw new AppError('You cannot deactivate the super admin account', 400);
      }
      data.isActive = isActive;
    }

    if ('role' in req.body) {
      const role = String(req.body.role);
      if (!['OWNER', 'ADMIN', 'MEMBER'].includes(role)) throw new AppError('Invalid role');
      // Never leave an organization with nobody who can administer it.
      if (user.role === 'OWNER' && role !== 'OWNER') {
        const otherOwners = await prisma.user.count({
          where: { organizationId: user.organizationId, role: 'OWNER', id: { not: user.id } },
        });
        if (otherOwners === 0) {
          throw new AppError('This is the only owner of that organization — promote someone else first', 400);
        }
      }
      data.role = role;
    }

    if (Object.keys(data).length === 0) throw new AppError('Nothing to update');

    const updated = await prisma.user.update({ where: { id: user.id }, data });
    // Role and active state are both baked into issued JWTs.
    await authService.revokeTokens(updated.id);

    res.json({
      success: true,
      data: { id: updated.id, role: updated.role, isActive: updated.isActive },
    });
  })
);

export default router;
