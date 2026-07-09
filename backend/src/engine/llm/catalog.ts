import { config } from '../../config/environment';

export type Provider = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek';

export interface ProviderInfo {
  label: string;
  /** OpenAI-compatible base URL; null means native Anthropic SDK. */
  baseURL: string | null;
  apiKey: () => string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    label: 'Anthropic',
    baseURL: null,
    apiKey: () => config.engine.anthropicApiKey,
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: () => process.env.OPENAI_API_KEY || '',
  },
  google: {
    label: 'Google',
    // Gemini's OpenAI-compatible endpoint
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: () => process.env.GEMINI_API_KEY || '',
  },
  xai: {
    label: 'xAI',
    baseURL: 'https://api.x.ai/v1',
    apiKey: () => process.env.XAI_API_KEY || '',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: () => process.env.DEEPSEEK_API_KEY || '',
  },
};

/** Longest-prefix routing: any model string resolves to a provider. */
const PREFIX_ROUTES: [string, Provider][] = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['gemini-', 'google'],
  ['grok-', 'xai'],
  ['deepseek-', 'deepseek'],
];

export function resolveProvider(model: string): Provider {
  const normalized = model.toLowerCase();
  let best: Provider | null = null;
  let bestLen = 0;
  for (const [prefix, provider] of PREFIX_ROUTES) {
    if (normalized.startsWith(prefix) && prefix.length > bestLen) {
      best = provider;
      bestLen = prefix.length;
    }
  }
  if (!best) throw new Error(`Cannot resolve a provider for model "${model}"`);
  return best;
}

export function isProviderConfigured(provider: Provider): boolean {
  return !!PROVIDERS[provider].apiKey();
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: Provider;
  recommended?: boolean;
}

/**
 * Curated model list shown in the UI. Any model string with a known prefix
 * works via resolveProvider even if it's not listed here, so adding new
 * models is a data change only.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', recommended: true },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'openai' },
  { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', provider: 'openai' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', provider: 'google' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google' },
  { id: 'grok-4', label: 'Grok 4', provider: 'xai' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', provider: 'deepseek' },
];

/**
 * Failover order when the active model's provider is erroring: the default
 * model first, then the first configured model of each remaining provider.
 */
export function failoverChain(excludeModel: string): string[] {
  const excludeProvider = resolveProvider(excludeModel);
  const chain: string[] = [];
  const seenProviders = new Set<Provider>([excludeProvider]);

  const defaultModel = config.engine.model;
  if (defaultModel !== excludeModel) {
    const p = resolveProvider(defaultModel);
    if (!seenProviders.has(p) && isProviderConfigured(p)) {
      chain.push(defaultModel);
      seenProviders.add(p);
    }
  }
  for (const entry of MODEL_CATALOG) {
    if (seenProviders.has(entry.provider)) continue;
    if (!isProviderConfigured(entry.provider)) continue;
    chain.push(entry.id);
    seenProviders.add(entry.provider);
  }
  return chain;
}
