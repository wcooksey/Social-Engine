import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL || '',

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
  },

  search: {
    apiKey: process.env.SEARCH_API_KEY || '',
    provider: process.env.SEARCH_API_PROVIDER || 'brave',
  },

  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY || '',
    domain: process.env.MAILGUN_DOMAIN || '',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  vapi: {
    apiKey: process.env.VAPI_API_KEY || '',
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || '',
    webhookSecret: process.env.VAPI_WEBHOOK_SECRET || '',
    assistantModel: process.env.VAPI_ASSISTANT_MODEL || 'gpt-4o',
    voiceProvider: process.env.VAPI_VOICE_PROVIDER || '11labs',
    voiceId: process.env.VAPI_VOICE_ID || 'burt',
  },
};

export function assertSecurityConfig(): void {
  if (!config.isProduction) return;
  if (config.jwt.secret === 'dev-secret' || config.jwt.refreshSecret === 'dev-refresh-secret') {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
  }
}
