import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL || '',

  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || '',

  // Extra allowed CORS origins in production (comma-separated). The backend
  // serves the frontend itself, so this stays empty unless the UI is hosted
  // on a different origin.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  engine: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ENGINE_MODEL || 'claude-sonnet-5',
    maxIterations: parseInt(process.env.ENGINE_MAX_ITERATIONS || '25', 10),
    workerIntervalMs: parseInt(process.env.ENGINE_WORKER_INTERVAL_MS || '15000', 10),
    // How many agent jobs run at once across all orgs, and the cap per org so
    // one org can't starve others or blow past its rate limits.
    workerConcurrency: parseInt(process.env.ENGINE_WORKER_CONCURRENCY || '4', 10),
    orgConcurrency: parseInt(process.env.ENGINE_ORG_CONCURRENCY || '2', 10),
  },

  search: {
    apiKey: process.env.SEARCH_API_KEY || '',
    provider: process.env.SEARCH_API_PROVIDER || 'brave',
  },

  // Channel credentials (Mailgun/Twilio/Vapi) live in per-org settings now —
  // resolved via settings.service getOrgConfig with process.env as fallback.

  browser: {
    // Path to a Playwright storageState JSON for pre-authenticated social sessions
    storageStatePath: process.env.BROWSER_STORAGE_STATE || '',
    maxSteps: parseInt(process.env.BROWSER_AGENT_MAX_STEPS || '18', 10),
  },

  inbound: {
    // Shared secret for inbound reply webhooks (email/SMS/social bridges)
    webhookSecret: process.env.INBOUND_WEBHOOK_SECRET || '',
  },

};

export function assertSecurityConfig(): void {
  if (!config.isProduction) return;
  if (config.jwt.secret === 'dev-secret' || config.jwt.refreshSecret === 'dev-refresh-secret') {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
  }
}
