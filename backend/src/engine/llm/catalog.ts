import { config } from '../../config/environment';

export type Provider = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'moonshot';

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
  moonshot: {
    label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: () => process.env.MOONSHOT_API_KEY || '',
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
  // Moonshot serves its models under the Kimi name; `moonshot-v1-*` is the
  // older family, still resolvable so a saved id doesn't dead-end.
  ['kimi-', 'moonshot'],
  ['moonshot-', 'moonshot'],
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
  /** USD per million input tokens that were NOT served from the prompt cache. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /**
   * USD per million input tokens served from the provider's prompt cache.
   *
   * This is not a rounding detail. An agent loop resends the whole system
   * prompt, every tool definition and the full history on each iteration, so
   * after the first call nearly all input is a cache hit — and DeepSeek prices
   * those at roughly 1/120th of a miss. Charging every input token at the miss
   * rate overstated real spend several times over.
   *
   * Omit when a provider's cache discount isn't known; the estimate then falls
   * back to the full input rate, which errs high rather than flattering itself.
   */
  cachedInputPerMTok?: number;
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
  // Pricing = cache-miss input / cache-hit input / output per M tokens
  // (official). DeepSeek caches prompt prefixes automatically — no
  // cache_control needed — so the hit rate is the one that dominates an agent
  // loop's bill, at ~1/120th of a miss on Pro and ~1/50th on Flash.
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'deepseek', pricing: { inputPerMTok: 0.435, cachedInputPerMTok: 0.003625, outputPerMTok: 0.87 } },
  // V4.1 Flash uses deepseek-flash. Estimate at peak rates; off-peak is 50% less.
  // https://api-docs.deepseek.com/quick_start/pricing/
  { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', provider: 'deepseek', pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 } },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek', pricing: { inputPerMTok: 0.14, cachedInputPerMTok: 0.0028, outputPerMTok: 0.28 } },
  // Moonshot (Kimi). Pricing = cache-miss input / cache-hit input / output per
  // M tokens at Moonshot's own list rates. Context caching is automatic on the
  // K2.x and K3 families — no cache_control, no cache id — and the hit rate is
  // a 90% discount on K3, so it, not the miss rate, is what an agent loop
  // actually pays for its resent prefix. K3 hits the prefix cache only once a
  // prompt clears 256 tokens, which every Engine turn does several times over.
  { id: 'kimi-k3', label: 'Kimi K3', provider: 'moonshot', pricing: { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 } },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'moonshot', pricing: { inputPerMTok: 0.95, cachedInputPerMTok: 0.19, outputPerMTok: 4 } },
  { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code (High-Speed)', provider: 'moonshot', pricing: { inputPerMTok: 1.9, cachedInputPerMTok: 0.38, outputPerMTok: 8 } },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'moonshot', pricing: { inputPerMTok: 0.95, cachedInputPerMTok: 0.16, outputPerMTok: 4 } },
];

// Provider-level fallback pricing for models not in the catalog.
const PROVIDER_DEFAULT_PRICING: Record<Provider, ModelPricing> = {
  anthropic: { inputPerMTok: 3, outputPerMTok: 15 },
  openai: { inputPerMTok: 1.25, outputPerMTok: 10 },
  google: { inputPerMTok: 2, outputPerMTok: 12 },
  xai: { inputPerMTok: 3, outputPerMTok: 15 },
  deepseek: { inputPerMTok: 0.435, cachedInputPerMTok: 0.003625, outputPerMTok: 0.87 },
  moonshot: { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
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

/**
 * Estimated USD cost of a call at list prices (no batch discounts).
 *
 * `inputTokens` is the provider's TOTAL prompt count, cache hits included —
 * that is what both OpenAI-compatible APIs and Anthropic report — so the
 * cached portion is subtracted out and repriced rather than added on top.
 * Passing 0 cached tokens reproduces the old full-price behaviour exactly.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  const p = pricingForModel(model);
  // Guard against a provider reporting more cached than total: a negative
  // billable count would silently credit the org.
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const fresh = inputTokens - cached;
  const cachedRate = p.cachedInputPerMTok ?? p.inputPerMTok;
  return (fresh * p.inputPerMTok + cached * cachedRate + outputTokens * p.outputPerMTok) / 1_000_000;
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
