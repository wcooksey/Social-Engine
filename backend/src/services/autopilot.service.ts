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

    // Completion criterion: the linked group reached its target size.
    let groupCount: number | null = null;
    if (goal.leadGroupId) {
      groupCount = await prisma.lead.count({ where: { groupId: goal.leadGroupId } });
      if (goal.targetLeadCount && groupCount >= goal.targetLeadCount) {
        await prisma.autopilotGoal.update({
          where: { id: goal.id },
          data: {
            status: 'COMPLETED',
            lastResult: `Target reached: ${groupCount}/${goal.targetLeadCount} leads in "${goal.leadGroup?.name}".`,
          },
        });
        await notify({
          organizationId: goal.organizationId,
          type: 'SYSTEM',
          title: `Autopilot goal completed: ${goal.name}`,
          body: `"${goal.leadGroup?.name}" reached ${groupCount} leads (target ${goal.targetLeadCount}).`,
        });
        continue;
      }
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
      progress.push(
        `Lead group "${goal.leadGroup.name}" currently has ${groupCount ?? 0} leads` +
          (goal.targetLeadCount ? ` (goal target: ${goal.targetLeadCount})` : '')
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
