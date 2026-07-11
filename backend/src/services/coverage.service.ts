import { CoverageCellStatus } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Coverage tracking for bird's-eye sourcing objectives. The Coordinator plans
 * a grid of granular cells (e.g. city × brand); Researchers claim cells
 * ATOMICALLY (safe under parallel agents), source leads for each, and mark
 * them done. Progress is a database fact, so any later session knows exactly
 * what remains — never re-searching covered ground.
 */

export async function planCells(
  organizationId: string,
  groupId: string,
  cells: { label: string; query: string }[]
): Promise<{ created: number; existing: number }> {
  const rows = cells
    .map((c) => ({ query: c.query.trim(), label: (c.label || c.query).trim() }))
    .filter((c) => c.query !== '')
    .map((c) => ({ organizationId, groupId, label: c.label, query: c.query }));
  if (rows.length === 0) return { created: 0, existing: 0 };
  // skipDuplicates makes re-planning idempotent: existing cells keep their
  // status, so a second session can safely re-plan the same grid.
  const result = await prisma.coverageCell.createMany({ data: rows, skipDuplicates: true });
  return { created: result.count, existing: rows.length - result.count };
}

export interface CoverageSummary {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  empty: number;
  leadsFound: number;
}

export async function summarize(groupId: string): Promise<CoverageSummary> {
  const cells = await prisma.coverageCell.groupBy({
    by: ['status'],
    where: { groupId },
    _count: true,
    _sum: { leadsFound: true },
  });
  const count = (s: CoverageCellStatus) => cells.find((c) => c.status === s)?._count ?? 0;
  return {
    total: cells.reduce((n, c) => n + c._count, 0),
    pending: count('PENDING'),
    inProgress: count('IN_PROGRESS'),
    done: count('DONE'),
    empty: count('EMPTY'),
    leadsFound: cells.reduce((n, c) => n + (c._sum.leadsFound ?? 0), 0),
  };
}

/** Atomically claim up to `count` pending cells (parallel-agent safe). */
export async function claimNextCells(
  organizationId: string,
  groupId: string,
  count: number
): Promise<{ id: string; label: string; query: string }[]> {
  const claimed: { id: string; label: string; query: string }[] = [];
  // Stale claims (an agent died mid-cell) become claimable again after 30 min.
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000);

  for (let i = 0; i < count; i++) {
    const candidate = await prisma.coverageCell.findFirst({
      where: {
        organizationId,
        groupId,
        OR: [
          { status: 'PENDING' },
          { status: 'IN_PROGRESS', updatedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) break;
    const res = await prisma.coverageCell.updateMany({
      where: { id: candidate.id, status: candidate.status }, // status guard = atomic claim
      data: { status: 'IN_PROGRESS', lastRunAt: new Date() },
    });
    if (res.count === 0) {
      i--; // raced another agent; try the next candidate
      continue;
    }
    claimed.push({ id: candidate.id, label: candidate.label, query: candidate.query });
  }
  return claimed;
}

export async function completeCell(
  organizationId: string,
  cellId: string,
  outcome: { leadsFound: number; notes?: string }
): Promise<void> {
  const cell = await prisma.coverageCell.findFirst({ where: { id: cellId, organizationId } });
  if (!cell) throw new Error(`Coverage cell ${cellId} not found`);
  await prisma.coverageCell.update({
    where: { id: cell.id },
    data: {
      status: outcome.leadsFound > 0 ? 'DONE' : 'EMPTY',
      leadsFound: outcome.leadsFound,
      notes: outcome.notes,
      lastRunAt: new Date(),
    },
  });
}
