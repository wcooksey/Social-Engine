import { AutopilotMetric, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { notify } from './notification.service';

/**
 * Autopilot: standing goals the platform keeps working mechanically. Without
 * this, long-running autonomy depends on each agent remembering to schedule
 * its successor — and one terminally failed job silently kills the chain.
 * Here the sweep (not agent memory) re-queues a job for every ACTIVE goal on
 * its cadence, checks completion criteria, and tells the humans when a goal
 * completes. The queued job runs through the normal worker with the goal's
 * objective plus live progress context.
 */

/** Max goal jobs queued per sweep pass (safety valve, not a practical limit). */
const MAX_QUEUED_PER_SWEEP = 50;

/**
 * What each metric counts, and how it reads in progress/completion messages.
 * ENRICHED_LEADS and LEADS_WITH_EMAIL rely on the denormalized enrichment
 * columns, so both are plain indexed counts rather than joins over contacts.
 */
const METRIC_DEFINITIONS: Record<
  AutopilotMetric,
  { where: (groupId: string) => Prisma.LeadWhereInput; noun: string }
> = {
  LEAD_COUNT: {
    where: (groupId) => ({ groupId }),
    noun: 'leads',
  },
  ENRICHED_LEADS: {
    where: (groupId) => ({ groupId, enrichmentTier: { in: ['GOOD', 'RICH'] } }),
    noun: 'leads enriched to GOOD/RICH',
  },
  LEADS_WITH_EMAIL: {
    where: (groupId) => ({ groupId, emailCount: { gt: 0 } }),
    noun: 'leads with a usable email',
  },
};

export interface GoalProgress {
  current: number;
  target: number;
  satisfied: boolean;
  noun: string;
  /** Ready-to-print summary, e.g. "12/250 leads enriched to GOOD/RICH". */
  label: string;
}

/**
 * Evaluate a goal's completion criterion. Shared by the creation guard and the
 * sweep so the two can never disagree about what "done" means. Returns null
 * when the goal has no measurable target.
 */
export async function evaluateGoalProgress(goal: {
  leadGroupId: string | null;
  targetLeadCount: number | null;
  targetMetric: AutopilotMetric;
}): Promise<GoalProgress | null> {
  if (!goal.leadGroupId || !goal.targetLeadCount) return null;
  const definition = METRIC_DEFINITIONS[goal.targetMetric] ?? METRIC_DEFINITIONS.LEAD_COUNT;
  const current = await prisma.lead.count({ where: definition.where(goal.leadGroupId) });
  return {
    current,
    target: goal.targetLeadCount,
    satisfied: current >= goal.targetLeadCount,
    noun: definition.noun,
    label: `${current}/${goal.targetLeadCount} ${definition.noun}`,
  };
}

export async function runAutopilotSweep(): Promise<number> {
  const due = await prisma.autopilotGoal.findMany({
    where: {
      status: 'ACTIVE',
      nextRunAt: { lte: new Date() },
      organization: { paused: false },
    },
    include: {
      leadGroup: { select: { id: true, name: true } },
      campaign: { select: { id: true, name: true, status: true } },
    },
    orderBy: { nextRunAt: 'asc' },
    take: MAX_QUEUED_PER_SWEEP,
  });

  let queued = 0;
  for (const goal of due) {
    // Advance the clock first — even if this pass errors below, the goal
    // won't be retried in a tight loop every sweep tick.
    const nextRunAt = new Date(Date.now() + goal.cadenceHours * 3600 * 1000);
    await prisma.autopilotGoal.update({
      where: { id: goal.id },
      data: { nextRunAt },
    });

    // Completion criterion, measured against whatever this goal actually
    // counts — raw group size for sourcing, reachable leads for enrichment.
    const progressNow = await evaluateGoalProgress(goal);
    if (progressNow?.satisfied) {
      await prisma.autopilotGoal.update({
        where: { id: goal.id },
        data: {
          status: 'COMPLETED',
          lastResult: `Target reached: ${progressNow.label} in "${goal.leadGroup?.name}".`,
        },
      });
      await notify({
        organizationId: goal.organizationId,
        type: 'SYSTEM',
        title: `Autopilot goal completed: ${goal.name}`,
        body: `"${goal.leadGroup?.name}" reached ${progressNow.label}.`,
      });
      continue;
    }

    // Don't stack work: if this goal's previous job is still pending/running,
    // skip this cycle rather than queue a duplicate behind it.
    const inFlight = await prisma.agentJob.findFirst({
      where: {
        organizationId: goal.organizationId,
        status: { in: ['PENDING', 'RUNNING'] },
        payload: { path: ['autopilotGoalId'], equals: goal.id },
      },
      select: { id: true },
    });
    if (inFlight) continue;

    const progress: string[] = [];
    if (goal.leadGroup) {
      // Report progress in the goal's own terms, so an enrichment goal shows
      // how many leads are actually reachable rather than how many exist.
      const groupSize = await prisma.lead.count({ where: { groupId: goal.leadGroup.id } });
      progress.push(
        `Lead group "${goal.leadGroup.name}" has ${groupSize} leads` +
          (progressNow ? ` — progress toward this goal: ${progressNow.label}` : '')
      );
    }
    if (goal.campaign) {
      progress.push(`Linked campaign: "${goal.campaign.name}" (${goal.campaign.status})`);
    }

    await prisma.agentJob.create({
      data: {
        organizationId: goal.organizationId,
        campaignId: goal.campaignId,
        type: 'CUSTOM',
        role: goal.role,
        objective:
          `[Autopilot goal: "${goal.name}" — this instruction re-runs every ${goal.cadenceHours}h until the goal completes. ` +
          `Do the next meaningful chunk of work toward it now.]\n\n${goal.objective}` +
          (progress.length ? `\n\nCurrent progress:\n${progress.map((p) => `- ${p}`).join('\n')}` : ''),
        payload: { autopilotGoalId: goal.id },
        runAt: new Date(),
      },
    });
    await prisma.autopilotGoal.update({
      where: { id: goal.id },
      data: { lastQueuedAt: new Date() },
    });
    queued++;
  }
  return queued;
}

/**
 * Record a goal job's outcome on the goal (for the UI) — called by the worker
 * when a job carrying an autopilotGoalId finishes or fails terminally.
 */
export async function recordGoalJobOutcome(
  payload: unknown,
  outcome: string
): Promise<void> {
  const goalId =
    payload && typeof payload === 'object'
      ? (payload as { autopilotGoalId?: unknown }).autopilotGoalId
      : undefined;
  if (typeof goalId !== 'string') return;
  await prisma.autopilotGoal
    .update({ where: { id: goalId }, data: { lastResult: outcome.slice(0, 1000) } })
    .catch(() => undefined);
}
