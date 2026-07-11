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

/** Per-org resolved provider keys (from settings). Falls back to env in PROVIDERS. */
export type ProviderKeys = Partial<Record<Provider, string>>;

export function providerKey(provider: Provider, keys?: ProviderKeys): string {
  return (keys && keys[provider]) || PROVIDERS[provider].apiKey();
}

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

export function isProviderConfigured(provider: Provider, keys?: ProviderKeys): boolean {
  return !!providerKey(provider, keys);
}

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: Provider;
  recommended?: boolean;
  /** Published list prices (estimates — vendors change them; update here). */
  pricing?: ModelPricing;
}

/**
 * Curated model list shown in the UI. Any model string with a known prefix
 * works via resolveProvider even if it's not listed here, so adding new
 * models is a data change only.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', recommended: true, pricing: { inputPerMTok: 3, outputPerMTok: 15 } },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', pricing: { inputPerMTok: 5, outputPerMTok: 25 } },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', pricing: { inputPerMTok: 1, outputPerMTok: 5 } },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'openai', pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } },
  { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', provider: 'openai', pricing: { inputPerMTok: 0.25, outputPerMTok: 2 } },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', provider: 'google', pricing: { inputPerMTok: 2, outputPerMTok: 12 } },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 } },
  { id: 'grok-4', label: 'Grok 4', provider: 'xai', pricing: { inputPerMTok: 3, outputPerMTok: 15 } },
  // deepseek-chat / deepseek-reasoner are deprecated 2026/07/24 → V4 models.
  // Pricing = cache-miss input / output per M tokens (official).
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'deepseek', pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87 } },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek', pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 } },
];

// Provider-level fallback pricing for models not in the catalog.
const PROVIDER_DEFAULT_PRICING: Record<Provider, ModelPricing> = {
  anthropic: { inputPerMTok: 3, outputPerMTok: 15 },
  openai: { inputPerMTok: 1.25, outputPerMTok: 10 },
  google: { inputPerMTok: 2, outputPerMTok: 12 },
  xai: { inputPerMTok: 3, outputPerMTok: 15 },
  deepseek: { inputPerMTok: 0.435, outputPerMTok: 0.87 },
};

export function pricingForModel(model: string): ModelPricing {
  const entry = MODEL_CATALOG.find((m) => m.id === model);
  if (entry?.pricing) return entry.pricing;
  try {
    return PROVIDER_DEFAULT_PRICING[resolveProvider(model)];
  } catch {
    return { inputPerMTok: 3, outputPerMTok: 15 };
  }
}

/** Estimated USD cost of a call — list prices, no caching/batch discounts. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingForModel(model);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

/**
 * Failover order when the active model's provider is erroring: the default
 * model first, then the first configured model of each remaining provider.
 */
export function failoverChain(excludeModel: string, keys?: ProviderKeys): string[] {
  const excludeProvider = resolveProvider(excludeModel);
  const chain: string[] = [];
  const seenProviders = new Set<Provider>([excludeProvider]);

  const defaultModel = config.engine.model;
  if (defaultModel !== excludeModel) {
    const p = resolveProvider(defaultModel);
    if (!seenProviders.has(p) && isProviderConfigured(p, keys)) {
      chain.push(defaultModel);
      seenProviders.add(p);
    }
  }
  for (const entry of MODEL_CATALOG) {
    if (seenProviders.has(entry.provider)) continue;
    if (!isProviderConfigured(entry.provider, keys)) continue;
    chain.push(entry.id);
    seenProviders.add(entry.provider);
  }
  return chain;
}
