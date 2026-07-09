import { prisma } from '../config/database';
import { config } from '../config/environment';
import { engineService } from './engine.service';

const MAX_ATTEMPTS = 3;

let timer: NodeJS.Timeout | null = null;
let draining = false;

/**
 * The scheduler that gives the Engine autonomy: polls the AgentJob table for
 * due work (follow-ups the Engine scheduled for itself, campaign steps,
 * research chunks) and executes each as a fresh Engine run.
 */
export function startEngineWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void drainDueJobs();
  }, config.engine.workerIntervalMs);
  console.log(`Engine worker started (every ${config.engine.workerIntervalMs}ms)`);
}

export function stopEngineWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function drainDueJobs(): Promise<void> {
  if (draining) return; // one drain at a time
  draining = true;
  try {
    // Claim jobs one at a time so a crash mid-batch loses at most one claim.
    for (;;) {
      const job = await prisma.agentJob.findFirst({
        where: {
          status: 'PENDING',
          runAt: { lte: new Date() },
          organization: { paused: false },
        },
        orderBy: { runAt: 'asc' },
      });
      if (!job) break;

      const claimed = await prisma.agentJob.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'RUNNING', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // raced with another worker

      try {
        const context: string[] = [];
        if (job.leadId) context.push(`leadId: ${job.leadId}`);
        if (job.campaignId) context.push(`campaignId: ${job.campaignId}`);
        const objective =
          `${job.objective}` + (context.length ? `\n\n(Context — ${context.join(', ')})` : '');

        const result = await engineService.run({
          organizationId: job.organizationId,
          trigger: 'SCHEDULED_JOB',
          objective,
        });

        await prisma.agentJob.update({
          where: { id: job.id },
          data:
            result.status === 'COMPLETED'
              ? { status: 'COMPLETED' }
              : job.attempts >= MAX_ATTEMPTS
                ? { status: 'FAILED', lastError: result.error }
                : {
                    status: 'PENDING',
                    lastError: result.error,
                    runAt: new Date(Date.now() + 10 * 60 * 1000), // retry in 10 min
                  },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Job execution failed';
        await prisma.agentJob.update({
          where: { id: job.id },
          data:
            job.attempts >= MAX_ATTEMPTS
              ? { status: 'FAILED', lastError: message }
              : { status: 'PENDING', lastError: message, runAt: new Date(Date.now() + 10 * 60 * 1000) },
        });
      }
    }
  } finally {
    draining = false;
  }
}
