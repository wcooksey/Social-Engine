import app from './app';
import { prisma } from './config/database';
import { assertSecurityConfig, config } from './config/environment';
import { startEngineWorker, stopEngineWorker } from './engine/worker';
import { recoverOrphanedWork } from './engine/orphan-recovery';

async function main(): Promise<void> {
  // Fail fast on missing production secrets — the message tells the operator
  // exactly which env vars to set.
  assertSecurityConfig();

  // Bind the HTTP port FIRST so the platform's healthcheck sees a live server
  // (and stops returning 502) even if the database or worker misconfigures.
  // Explicit host 0.0.0.0 so the container is reachable on hosts like Railway.
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Neuralnetics API listening on :${config.port} (${config.nodeEnv})`);
  });

  // Loud, because the consequence is silent: unset, every unsubscribe link,
  // booking link and calendar invite sent to a prospect points at localhost.
  // In production outbound is refused outright (see outboundBlockReason); the
  // warning fires everywhere so it is noticed before the deploy, not after.
  if (config.appPublicUrlIsUnreachable) {
    const message =
      `APP_PUBLIC_URL is ${config.appPublicUrl}, which no recipient can reach —\n` +
      'unsubscribe links, booking links and calendar invites would all be dead on arrival.';
    if (config.isProduction) {
      console.error(
        `\n*** APP_PUBLIC_URL IS NOT PUBLICLY REACHABLE ***\n${message}\n` +
          'Outbound email is BLOCKED until this is set to the public URL of this deployment.\n'
      );
    } else {
      console.warn(`\nHeads up: ${message}\n(Fine for local dev; set it before deploying.)\n`);
    }
  }

  // Database connection is best-effort at boot: if it fails we keep serving so
  // the error is visible in logs and /api/health stays green, rather than a
  // blind 502 crash loop.
  try {
    await prisma.$connect();
    console.log('Database connected');
  } catch (err) {
    console.error(
      '\n*** DATABASE CONNECTION FAILED ***\n' +
        'Check that DATABASE_URL is set and points at a reachable Postgres, and\n' +
        'that migrations have been applied (`prisma migrate deploy`).\n',
      err
    );
  }

  // Nothing can still be running at boot — this process is the only thing that
  // runs agents and it has just started — so any row that still says RUNNING
  // was stranded by the last restart. Close those out BEFORE the worker starts,
  // so recovered jobs are picked up on the first tick rather than sitting behind
  // a count of agents that no longer exist.
  try {
    const { runs, jobs } = await recoverOrphanedWork();
    if (runs || jobs) {
      console.log(
        `Recovered work stranded by the last restart: ${runs} run(s) closed, ${jobs} job(s) requeued.`
      );
    }
  } catch (err) {
    console.error('Orphaned-run recovery failed (continuing to serve):', err);
  }

  // Worker start is best-effort too — a web outage shouldn't follow from a
  // background-scheduler hiccup.
  try {
    await startEngineWorker();
  } catch (err) {
    console.error('Engine worker failed to start (web server still serving):', err);
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopEngineWorker();
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
