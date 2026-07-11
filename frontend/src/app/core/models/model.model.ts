export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek';

export interface ModelOption {
  id: string;
  label: string;
  provider: ModelProvider;
  providerLabel: string;
  /** False when the provider's API key isn't configured — the model can't be used yet. */
  configured: boolean;
  recommended?: boolean;
}

export interface ModelsResponse {
  models: ModelOption[];
  current: string;
}
