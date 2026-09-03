import { prisma } from '../config/database';
import { config } from '../config/environment';
import { decrypt, encrypt, isEncryptionConfigured } from '../utils/encryption';

/**
 * DB-backed settings with env fallback. Each account configures its own
 * integration keys in the app (stored encrypted); the platform-wide knobs are
 * super-admin only. Resolution precedence: DB value -> env var -> default.
 */

export interface OrgSettingDef {
  key: string; // canonical name, matches the env var name for clarity
  label: string;
  group: 'ai' | 'search' | 'email' | 'sms' | 'voice';
  secret: boolean;
  placeholder?: string;
}

// Registry of org-configurable settings (drives the Settings UI + resolution).
export const ORG_SETTING_DEFS: OrgSettingDef[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude) API key', group: 'ai', secret: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'ai', secret: true },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini API key', group: 'ai', secret: true },
  { key: 'XAI_API_KEY', label: 'xAI (Grok) API key', group: 'ai', secret: true },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', group: 'ai', secret: true },

  { key: 'SEARCH_API_KEY', label: 'Web search API key', group: 'search', secret: true },
  { key: 'SEARCH_API_PROVIDER', label: 'Search provider', group: 'search', secret: false, placeholder: 'brave' },
  { key: 'GOOGLE_PLACES_API_KEY', label: 'Google Places API key (lead sourcing)', group: 'search', secret: true },
  { key: 'APOLLO_API_KEY', label: 'Apollo API key (contact enrichment)', group: 'search', secret: true },

  // Per-organization inbound webhook secret. The deployment-wide secret cannot
  // identify a tenant, so a bridge that posts its own organizationId could
  // target any account; this makes the secret itself the identity.
  { key: 'INBOUND_WEBHOOK_SECRET', label: 'Inbound webhook secret (social bridges)', group: 'email', secret: true },

  { key: 'MAILGUN_API_KEY', label: 'Mailgun API key', group: 'email', secret: true },
  { key: 'MAILGUN_DOMAIN', label: 'Mailgun domain', group: 'email', secret: false },
  { key: 'MAILGUN_FROM_EMAIL', label: 'From address', group: 'email', secret: false, placeholder: 'blank = noreply@<domain>' },

  // Google OAuth client, for connecting a Gmail inbox as a sending channel.
  // These are the app's own credentials, not the inbox owner's: connecting an
  // inbox never asks anyone for a Google password, and the tokens that come
  // back live on the GmailAccount row, encrypted.
  { key: 'GOOGLE_OAUTH_CLIENT_ID', label: 'Google OAuth client ID (Gmail inbox)', group: 'email', secret: false, placeholder: '...apps.googleusercontent.com' },
  { key: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'Google OAuth client secret', group: 'email', secret: true },

  // Identity used when the browser agent fills out a prospect's "contact us"
  // form. The email deliberately reuses the Mailgun from address so their reply
  // lands on the inbound webhook and threads onto the lead automatically.
  { key: 'OUTREACH_SENDER_NAME', label: 'Your name (contact forms)', group: 'email', secret: false, placeholder: 'e.g. Will Cooksey' },
  { key: 'OUTREACH_SENDER_PHONE', label: 'Your phone (contact forms)', group: 'email', secret: false, placeholder: 'many forms require one' },
  // The link the phone agent texts when someone asks to see the product mid-call.
  { key: 'DEMO_VIDEO_URL', label: 'Demo video link', group: 'email', secret: false, placeholder: 'https://... — texted/emailed on request' },

  { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', group: 'sms', secret: false },
  { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', group: 'sms', secret: true },
  { key: 'TWILIO_FROM_NUMBER', label: 'Twilio from number', group: 'sms', secret: false, placeholder: '+1...' },

  { key: 'VAPI_API_KEY', label: 'Vapi API key', group: 'voice', secret: true },
  { key: 'VAPI_PHONE_NUMBER_ID', label: 'Vapi phone number ID', group: 'voice', secret: false },
  { key: 'VAPI_WEBHOOK_SECRET', label: 'Vapi webhook secret', group: 'voice', secret: true },
  { key: 'VAPI_ASSISTANT_MODEL', label: 'Vapi assistant model', group: 'voice', secret: false, placeholder: 'gpt-4o' },
  { key: 'VAPI_VOICE_PROVIDER', label: 'Vapi voice provider', group: 'voice', secret: false, placeholder: '11labs' },
  { key: 'VAPI_VOICE_ID', label: 'Vapi voice ID', group: 'voice', secret: false, placeholder: 'burt' },

  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key (Engine voice mode)', group: 'voice', secret: true },
  { key: 'ELEVENLABS_VOICE_ID', label: 'ElevenLabs voice ID', group: 'voice', secret: false, placeholder: 'blank = default voice' },
  { key: 'ELEVENLABS_LLM', label: 'ElevenLabs agent model', group: 'voice', secret: false, placeholder: 'claude-sonnet-4-5' },
];

const ORG_DEF_BY_KEY = new Map(ORG_SETTING_DEFS.map((d) => [d.key, d]));

// Platform (super-admin) settings.
export interface PlatformSettingDef {
  key: string;
  label: string;
  type: 'number';
  default: number;
  min: number;
  max: number;
}
export const PLATFORM_SETTING_DEFS: PlatformSettingDef[] = [
  { key: 'ENGINE_MAX_ITERATIONS', label: 'Engine max iterations per run', type: 'number', default: config.engine.maxIterations, min: 1, max: 200 },
  { key: 'ENGINE_WORKER_CONCURRENCY', label: 'Concurrent agents (global)', type: 'number', default: config.engine.workerConcurrency, min: 1, max: 64 },
  { key: 'ENGINE_ORG_CONCURRENCY', label: 'Concurrent agents per organization', type: 'number', default: config.engine.orgConcurrency, min: 1, max: 32 },
  { key: 'ENGINE_PLAYBOOK_CONCURRENCY', label: 'Concurrent agents per playbook', type: 'number', default: config.engine.playbookConcurrency, min: 1, max: 32 },
  { key: 'ENGINE_WORKER_INTERVAL_MS', label: 'Worker poll interval (ms)', type: 'number', default: config.engine.workerIntervalMs, min: 1000, max: 600000 },
];

// --- Raw value resolution -------------------------------------------------

async function rawOrgValue(organizationId: string, key: string): Promise<string | undefined> {
  const row = await prisma.orgSetting.findUnique({
    where: { organizationId_key: { organizationId, key } },
  });
  if (!row) return undefined;
  if (row.isSecret) {
    try {
      return decrypt(row.value);
    } catch {
      return undefined;
    }
  }
  return row.value;
}

/** Resolve one org setting: DB -> env -> undefined. */
export async function resolveOrg(organizationId: string, key: string): Promise<string> {
  const db = await rawOrgValue(organizationId, key);
  if (db !== undefined && db !== '') return db;
  return process.env[key] || '';
}

// --- Typed resolved config for consumers ----------------------------------

export interface ResolvedOrgConfig {
  providerKeys: {
    anthropic: string;
    openai: string;
    google: string;
    xai: string;
    deepseek: string;
  };
  search: { apiKey: string; provider: string; googlePlacesApiKey: string; apolloApiKey: string };
  mailgun: { apiKey: string; domain: string; fromEmail: string };
  /** OAuth client for connecting Gmail inboxes. Not per-inbox credentials. */
  googleOAuth: { clientId: string; clientSecret: string };
  /** Who we present as when filling a prospect's contact form. */
  outreachIdentity: { name: string; phone: string };
  /** Demo link the agents can send when a prospect asks to see it. */
  demoVideoUrl: string;
  twilio: { accountSid: string; authToken: string; fromNumber: string };
  vapi: {
    apiKey: string;
    phoneNumberId: string;
    webhookSecret: string;
    assistantModel: string;
    voiceProvider: string;
    voiceId: string;
  };
  elevenlabs: { apiKey: string; voiceId: string; llm: string };
}

export async function getOrgConfig(organizationId: string): Promise<ResolvedOrgConfig> {
  const g = (key: string) => resolveOrg(organizationId, key);
  const [
    anthropic, openai, gemini, xai, deepseek,
    searchKey, searchProvider, placesKey, apolloKey,
    mgKey, mgDomain, mgFrom, googleClientId, googleClientSecret,
    senderName, senderPhone, demoUrl,
    twSid, twToken, twFrom,
    vpKey, vpPhone, vpSecret, vpModel, vpVoiceProvider, vpVoiceId,
    elKey, elVoiceId, elLlm,
  ] = await Promise.all([
    g('ANTHROPIC_API_KEY'), g('OPENAI_API_KEY'), g('GEMINI_API_KEY'), g('XAI_API_KEY'), g('DEEPSEEK_API_KEY'),
    g('SEARCH_API_KEY'), g('SEARCH_API_PROVIDER'), g('GOOGLE_PLACES_API_KEY'), g('APOLLO_API_KEY'),
    g('MAILGUN_API_KEY'), g('MAILGUN_DOMAIN'), g('MAILGUN_FROM_EMAIL'),
    g('GOOGLE_OAUTH_CLIENT_ID'), g('GOOGLE_OAUTH_CLIENT_SECRET'),
    g('OUTREACH_SENDER_NAME'), g('OUTREACH_SENDER_PHONE'), g('DEMO_VIDEO_URL'),
    g('TWILIO_ACCOUNT_SID'), g('TWILIO_AUTH_TOKEN'), g('TWILIO_FROM_NUMBER'),
    g('VAPI_API_KEY'), g('VAPI_PHONE_NUMBER_ID'), g('VAPI_WEBHOOK_SECRET'),
    g('VAPI_ASSISTANT_MODEL'), g('VAPI_VOICE_PROVIDER'), g('VAPI_VOICE_ID'),
    g('ELEVENLABS_API_KEY'), g('ELEVENLABS_VOICE_ID'), g('ELEVENLABS_LLM'),
  ]);
  return {
    providerKeys: { anthropic, openai, google: gemini, xai, deepseek },
    search: { apiKey: searchKey, provider: searchProvider || 'brave', googlePlacesApiKey: placesKey, apolloApiKey: apolloKey },
    mailgun: { apiKey: mgKey, domain: mgDomain, fromEmail: mgFrom },
    googleOAuth: { clientId: googleClientId, clientSecret: googleClientSecret },
    outreachIdentity: { name: senderName, phone: senderPhone },
    demoVideoUrl: demoUrl,
    twilio: { accountSid: twSid, authToken: twToken, fromNumber: twFrom },
    vapi: {
      apiKey: vpKey,
      phoneNumberId: vpPhone,
      webhookSecret: vpSecret,
      assistantModel: vpModel || 'gpt-4o',
      voiceProvider: vpVoiceProvider || '11labs',
      voiceId: vpVoiceId || 'burt',
    },
    elevenlabs: { apiKey: elKey, voiceId: elVoiceId, llm: elLlm || 'claude-sonnet-4-5' },
  };
}

// --- Mutations ------------------------------------------------------------

export async function setOrgSetting(organizationId: string, key: string, value: string): Promise<void> {
  const def = ORG_DEF_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  const trimmed = value.trim();
  if (trimmed === '') {
    await prisma.orgSetting.deleteMany({ where: { organizationId, key } });
    return;
  }
  if (def.secret && !isEncryptionConfigured()) {
    throw new Error('APP_ENCRYPTION_KEY is not configured — cannot store secret settings.');
  }
  const stored = def.secret ? encrypt(trimmed) : trimmed;
  await prisma.orgSetting.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: { organizationId, key, value: stored, isSecret: def.secret },
    update: { value: stored, isSecret: def.secret },
  });
}

/** Masked view for the UI — never returns secret values, only whether set + source. */
export async function listOrgSettings(organizationId: string) {
  const rows = await prisma.orgSetting.findMany({ where: { organizationId } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return ORG_SETTING_DEFS.map((def) => {
    const row = byKey.get(def.key);
    const envValue = process.env[def.key] || '';
    const setInDb = !!row;
    const source = setInDb ? 'org' : envValue ? 'env' : 'unset';
    return {
      key: def.key,
      label: def.label,
      group: def.group,
      secret: def.secret,
      placeholder: def.placeholder,
      source,
      configured: setInDb || !!envValue,
      // Non-secret values can be shown; secrets never are.
      value: def.secret ? undefined : setInDb ? row!.value : envValue || undefined,
    };
  });
}

// --- Platform settings ----------------------------------------------------

export async function getPlatformNumber(key: string, fallback: number): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (row) {
    const n = parseInt(row.value, 10);
    if (!isNaN(n)) return n;
  }
  const env = process.env[key];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

export interface PlatformEngineConfig {
  maxIterations: number;
  workerConcurrency: number;
  orgConcurrency: number;
  playbookConcurrency: number;
  workerIntervalMs: number;
}

let platformCache: { at: number; value: PlatformEngineConfig } | null = null;

export async function getPlatformEngineConfig(): Promise<PlatformEngineConfig> {
  if (platformCache && Date.now() - platformCache.at < 10000) return platformCache.value;
  const [maxIterations, workerConcurrency, orgConcurrency, playbookConcurrency, workerIntervalMs] = await Promise.all([
    getPlatformNumber('ENGINE_MAX_ITERATIONS', config.engine.maxIterations),
    getPlatformNumber('ENGINE_WORKER_CONCURRENCY', config.engine.workerConcurrency),
    getPlatformNumber('ENGINE_ORG_CONCURRENCY', config.engine.orgConcurrency),
    getPlatformNumber('ENGINE_PLAYBOOK_CONCURRENCY', config.engine.playbookConcurrency),
    getPlatformNumber('ENGINE_WORKER_INTERVAL_MS', config.engine.workerIntervalMs),
  ]);
  const value = { maxIterations, workerConcurrency, orgConcurrency, playbookConcurrency, workerIntervalMs };
  platformCache = { at: Date.now(), value };
  return value;
}

export async function listPlatformSettings() {
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return PLATFORM_SETTING_DEFS.map((def) => {
    const row = byKey.get(def.key);
    const envValue = process.env[def.key];
    return {
      key: def.key,
      label: def.label,
      type: def.type,
      value: row ? parseInt(row.value, 10) : envValue ? parseInt(envValue, 10) : def.default,
      source: row ? 'platform' : envValue ? 'env' : 'default',
      default: def.default,
    };
  });
}

export async function setPlatformSetting(key: string, value: string): Promise<void> {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown platform setting: ${key}`);
  const n = parseInt(value, 10);
  if (isNaN(n)) throw new Error('Value must be a number');
  if (n < def.min || n > def.max) {
    throw new Error(`${def.label} must be between ${def.min} and ${def.max}`);
  }
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: String(n) },
    update: { value: String(n) },
  });
  platformCache = null;
}

export function isSuperAdmin(email: string | undefined): boolean {
  const su = config.superAdminEmail;
  return !!su && !!email && email.toLowerCase() === su.toLowerCase();
}
