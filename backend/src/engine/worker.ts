import { prisma } from '../config/database';
import { engineService } from './engine.service';
import { getPlatformEngineConfig } from '../services/settings.service';
import { runReminderSweep, runDigestSweepIfDue } from '../services/reminder.service';
import { runCadenceSweep } from '../services/campaign-cadence.service';
import { runAutopilotSweep, recordGoalJobOutcome } from '../services/autopilot.service';
import { releaseStaleResearchingLeads } from '../services/lead.service';
import { notify } from '../services/notification.service';
import { runSocialInboxSweeps } from './social-inbox.service';
import { AgentRole } from './roles';

const MAX_ATTEMPTS = 3;

let timer: NodeJS.Timeout | null = null;
let draining = false;
// Time-driven sweeps (reminders/digest) are cheaper than the job drain, so run
// them on a throttle rather than every tick.
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The scheduler that gives the team its autonomy: polls the AgentJob table for
 * due work and runs it as specialist agents — several at once. A global
 * concurrency cap bounds total load; a per-org cap keeps one org from starving
 * others or exceeding its rate limits. All agents share the same database, so a
 * Researcher, a Caller, and an SDR can work the same lead pool simultaneously
 * without stepping on each other (jobs are claimed atomically, leads dedupe,
 * the timeline is append-only).
 */
export async function startEngineWorker(): Promise<void> {
  if (timer) return;
  const platform = await getPlatformEngineConfig();
  timer = setInterval(() => {
    void drainDueJobs();
    void runTimeSweeps();
  }, platform.workerIntervalMs);
  console.log(
    `Engine worker started (every ${platform.workerIntervalMs}ms, ` +
      `${platform.workerConcurrency} concurrent, ${platform.orgConcurrency}/org). ` +
      `Concurrency updates live; interval changes need a restart.`
  );
}

export function stopEngineWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

interface ClaimedJob {
  id: string;
  organizationId: string;
  role: AgentRole;
  type: string;
  objective: string;
  leadId: string | null;
  campaignId: string | null;
  attempts: number;
  payload: unknown;
}

/** Atomically claim one due job for an org under its concurrency cap, or null. */
async function claimNextJob(
  orgInFlight: Map<string, number>,
  orgConcurrency: number
): Promise<ClaimedJob | null> {
  // Skip orgs already at their cap in the query itself so a hot org with a
  // deep backlog can't crowd claimable work from other orgs out of the batch.
  const overCapOrgs = [...orgInFlight.entries()]
    .filter(([, n]) => n >= orgConcurrency)
    .map(([orgId]) => orgId);
  const candidates = await prisma.agentJob.findMany({
    where: {
      status: 'PENDING',
      runAt: { lte: new Date() },
      organization: { paused: false },
      ...(overCapOrgs.length ? { organizationId: { notIn: overCapOrgs } } : {}),
    },
    orderBy: { runAt: 'asc' },
    take: 50,
  });

  for (const job of candidates) {
    if ((orgInFlight.get(job.organizationId) ?? 0) >= orgConcurrency) continue;
    const claimed = await prisma.agentJob.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'RUNNING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // raced another worker/slot
    return {
      id: job.id,
      organizationId: job.organizationId,
      role: job.role as AgentRole,
      type: job.type,
      objective: job.objective,
      leadId: job.leadId,
      campaignId: job.campaignId,
      attempts: job.attempts + 1,
      payload: job.payload,
    };
  }
  return null;
}

async function runJob(job: ClaimedJob): Promise<void> {
  try {
    const context: string[] = [];
    if (job.leadId) context.push(`leadId: ${job.leadId}`);
    if (job.campaignId) context.push(`campaignId: ${job.campaignId}`);
    const objective =
      `${job.objective}` + (context.length ? `\n\n(Context — ${context.join(', ')})` : '');

    const result = await engineService.run({
      organizationId: job.organizationId,
      trigger: 'SCHEDULED_JOB',
      role: job.role,
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
                runAt: new Date(Date.now() + 10 * 60 * 1000),
              },
    });
    if (result.status === 'COMPLETED') {
      await recordGoalJobOutcome(job.payload, result.finalText || 'Completed.');
    } else if (job.attempts >= MAX_ATTEMPTS) {
      await reportTerminalFailure(job, result.error || 'Run failed');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Job execution failed';
    await prisma.agentJob.update({
      where: { id: job.id },
      data:
        job.attempts >= MAX_ATTEMPTS
          ? { status: 'FAILED', lastError: message }
          : { status: 'PENDING', lastError: message, runAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    if (job.attempts >= MAX_ATTEMPTS) {
      await reportTerminalFailure(job, message);
    }
  }
}

/**
 * A job just failed for the last time. Silence here is what kills autonomy —
 * the humans (and any linked Autopilot goal) hear about it instead.
 */
async function reportTerminalFailure(job: ClaimedJob, error: string): Promise<void> {
  try {
    await recordGoalJobOutcome(job.payload, `FAILED after ${MAX_ATTEMPTS} attempts: ${error}`);
    await notify({
      organizationId: job.organizationId,
      type: 'SYSTEM',
      title: `Scheduled agent job failed permanently (${job.role})`,
      body: `"${job.objective.slice(0, 160)}" failed ${MAX_ATTEMPTS} times. Last error: ${error.slice(0, 300)}`,
      ...(job.leadId ? { leadId: job.leadId } : {}),
    });
  } catch (err) {
    console.error('Failed to report terminal job failure:', err instanceof Error ? err.message : err);
  }
}

/** Throttled meeting-reminder + daily-digest sweeps. */
async function runTimeSweeps(): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    await runReminderSweep();
    await runCadenceSweep();
    await runAutopilotSweep();
    // Free leads stranded in RESEARCHING by a run that ended without contacting
    // them — otherwise they look busy forever and never get picked up again.
    const released = await releaseStaleResearchingLeads();
    if (released > 0) console.log(`Released ${released} lead(s) stuck in RESEARCHING back to NEW.`);
    await runDigestSweepIfDue();
    // Reads connected social DM inboxes for replies (hourly per account).
    await runSocialInboxSweeps();
  } catch (err) {
    console.error('Time sweep error:', err instanceof Error ? err.message : err);
  }
}

export async function drainDueJobs(): Promise<void> {
  if (draining) return; // one drain cycle at a time; each cycle runs a pool
  draining = true;

  const platform = await getPlatformEngineConfig();
  const maxConcurrency = platform.workerConcurrency;
  const orgConcurrency = platform.orgConcurrency;
  const orgInFlight = new Map<string, number>();
  const active = new Map<symbol, Promise<void>>();

  const launch = (job: ClaimedJob) => {
    orgInFlight.set(job.organizationId, (orgInFlight.get(job.organizationId) ?? 0) + 1);
    const key = Symbol();
    const p = runJob(job).finally(() => {
      orgInFlight.set(job.organizationId, (orgInFlight.get(job.organizationId) ?? 1) - 1);
      active.delete(key);
    });
    active.set(key, p);
  };

  try {
    for (;;) {
      // Fill open slots with claimable jobs.
      while (active.size < maxConcurrency) {
        const job = await claimNextJob(orgInFlight, orgConcurrency);
        if (!job) break;
        launch(job);
      }
      if (active.size === 0) break; // nothing running and nothing claimable
      // Wait for at least one slot to free up, then try to fill again.
      await Promise.race(active.values());
    }
  } finally {
    draining = false;
  }
}
