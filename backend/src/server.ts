import app from './app';
import { prisma } from './config/database';
import { assertSecurityConfig, config } from './config/environment';
import { startEngineWorker, stopEngineWorker } from './engine/worker';

async function main(): Promise<void> {
  assertSecurityConfig();
  await prisma.$connect();
  console.log('Database connected');

  const server = app.listen(config.port, () => {
    console.log(`Social Engine API listening on :${config.port} (${config.nodeEnv})`);
  });

  await startEngineWorker();

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopEngineWorker();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
