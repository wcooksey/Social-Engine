import { prisma } from '../config/database';

/**
 * Recovery for work stranded by a process that died mid-flight.
 *
 * A run's controllability lives in an in-memory registry, but its status lives
 * in the database. A restart — a deploy, a crash, an OOM kill — wipes the
 * registry while leaving every in-flight row saying RUNNING. Nothing ever
 * reconciled the two, so those rows sat there forever: the fleet view counted
 * them as live agents, and because the registry had never heard of them there
 * was no way to stop them. "Stop everything" could not touch them either,
 * since there was nothing left to stop — only a row lying about its state.
 *
 * At boot, nothing can still be running: this process is the only thing that
 * runs agents, and it has just started. So every RUNNING row is by definition
 * orphaned and is closed out here.
 */

/** What a boot-time sweep cleaned up, for the startup log. */
export interface OrphanSweepResult {
  runs: number;
  jobs: number;
}

const ORPHAN_MESSAGE =
  'Interrupted by a server restart — the process running this agent stopped before it finished.';

export async function recoverOrphanedWork(): Promise<OrphanSweepResult> {
  const now = new Date();

  // Runs are marked FAILED rather than CANCELLED: nobody chose to stop these,
  // and calling it a cancellation would hide a restart that ate real work.
  const runs = await prisma.agentRun.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', error: ORPHAN_MESSAGE, summary: ORPHAN_MESSAGE, finishedAt: now },
  });

  // Jobs go back to PENDING instead, so the work is actually retried rather
  // than silently dropped. Their attempt counter was already incremented when
  // they were claimed, so a job whose agent keeps killing the process still
  // exhausts its retries and stops instead of looping forever.
  const jobs = await prisma.agentJob.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'PENDING', lastError: ORPHAN_MESSAGE, runAt: now },
  });

  return { runs: runs.count, jobs: jobs.count };
}

/**
 * Force-close a single run that the registry no longer tracks.
 *
 * The normal stop path talks to the live run and lets it halt at a step
 * boundary. That is impossible for an orphan — there is no loop listening — so
 * this closes the record directly. Scoped by organizationId, and refuses to
 * touch a run the registry still owns: those must go through the real stop so
 * the agent isn't left executing against a row that claims it finished.
 */
export async function forceStopRun(
  organizationId: string,
  runId: string
): Promise<{ stopped: boolean; reason?: string }> {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, organizationId },
    select: { id: true, status: true },
  });
  if (!run) return { stopped: false, reason: 'not_found' };
  if (run.status !== 'RUNNING') return { stopped: false, reason: 'already_finished' };

  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'CANCELLED',
      summary: 'Stopped by an operator.',
      finishedAt: new Date(),
    },
  });
  return { stopped: true };
}

/**
 * Close out every RUNNING row for one organization — the "stop everything"
 * backstop. Live runs are cancelled through the registry by the caller first;
 * this catches whatever is left, which is exactly the orphaned rows that used
 * to be unstoppable.
 */
export async function forceStopAllRuns(organizationId: string): Promise<number> {
  const result = await prisma.agentRun.updateMany({
    where: { organizationId, status: 'RUNNING' },
    data: {
      status: 'CANCELLED',
      summary: 'Stopped by an operator.',
      finishedAt: new Date(),
    },
  });
  return result.count;
}
