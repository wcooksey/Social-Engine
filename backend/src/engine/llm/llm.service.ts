import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  failoverChain,
  isProviderConfigured,
  Provider,
  ProviderKeys,
  providerKey,
  PROVIDERS,
  resolveProvider,
} from './catalog';

// ---------------------------------------------------------------------------
// Provider-agnostic chat types. The Engine loop speaks only this dialect;
// per-provider adapters translate to/from each wire format.
// ---------------------------------------------------------------------------

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic input_schema shape). */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | {
      role: 'tool';
      results: { toolCallId: string; name: string; content: string; isError?: boolean }[];
    };

export interface LlmChatRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens?: number;
}

export interface LlmChatResponse {
  text: string;
  toolCalls: LlmToolCall[];
  /**
   * `inputTokens` is the provider's total prompt count. `cachedInputTokens` is
   * the portion of it served from the prompt cache — a subset, not an extra —
   * and is priced far lower. Without it an agent loop, which resends its whole
   * prompt every iteration, looks several times more expensive than the bill.
   */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  /** Model that actually served the request (differs from request on failover). */
  model: string;
  provider: Provider;
}

// ---------------------------------------------------------------------------
// Clients (cached per provider)
// ---------------------------------------------------------------------------

const anthropicClients = new Map<string, Anthropic>();
const openaiClients = new Map<string, OpenAI>();

function getAnthropicClient(apiKey: string): Anthropic {
  if (!apiKey) throw new LlmNotConfiguredError('anthropic');
  let client = anthropicClients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    anthropicClients.set(apiKey, client);
  }
  return client;
}

function getOpenAICompatibleClient(provider: Provider, apiKey: string): OpenAI {
  const info = PROVIDERS[provider];
  if (!apiKey) throw new LlmNotConfiguredError(provider);
  const cacheKey = `${provider}:${apiKey}`;
  let client = openaiClients.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL: info.baseURL ?? undefined, maxRetries: 1 });
    openaiClients.set(cacheKey, client);
  }
  return client;
}

export class LlmNotConfiguredError extends Error {
  provider: Provider;
  constructor(provider: Provider) {
    super(
      `${PROVIDERS[provider].label} is not configured — add its API key in Settings → Integrations & API keys.`
    );
    this.provider = provider;
  }
}

/** True for errors worth failing over on: outages, rate limits, timeouts. */
function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof LlmNotConfiguredError) return true;
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number') {
    return status === 429 || status === 408 || status >= 500;
  }
  // Connection-level failures have no status
  const code = (err as { code?: string }).code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(code || '');
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

async function chatAnthropic(request: LlmChatRequest, keys?: ProviderKeys): Promise<LlmChatResponse> {
  const client = getAnthropicClient(providerKey('anthropic', keys));

  const messages: Anthropic.MessageParam[] = request.messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: m.results.map(
          (r): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: r.toolCallId,
            content: r.content,
            is_error: r.isError,
          })
        ),
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      return { role: 'assistant' as const, content: blocks };
    }
    return { role: m.role, content: m.content };
  });

  // Cache the static prefix. The system prompt and the tool catalogue are
  // identical on every iteration of an agent loop and together run to thousands
  // of tokens, so without a breakpoint the whole prefix is re-billed at full
  // rate on every single turn — by far the largest line in the bill.
  //
  // The breakpoint goes on the LAST tool: Anthropic caches everything up to and
  // including the marked block, and the order is system, then tools, then
  // messages. One breakpoint therefore covers both.
  const tools: Anthropic.Tool[] = request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  if (tools.length > 0) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }

  const response = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    // A block array rather than a bare string, so the prefix can carry a
    // breakpoint of its own when there are no tools to hang one on.
    system: [
      {
        type: 'text' as const,
        text: request.system,
        ...(tools.length === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ],
    tools,
    messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

  return {
    text,
    toolCalls,
    usage: {
      // Anthropic reports cache reads OUTSIDE input_tokens, so the billable
      // total is the sum. Cache writes are billed at a premium and reads at a
      // discount; both are counted here so the cost estimate tracks the real
      // bill rather than the uncached list price.
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model: request.model,
    provider: 'anthropic',
  };
}

/**
 * Prompt tokens the provider served from cache, out of `prompt_tokens`.
 *
 * The OpenAI-compatible surface is not standardised here: DeepSeek reports
 * `prompt_cache_hit_tokens` at the top level, while OpenAI (and providers
 * copying it) nest `prompt_tokens_details.cached_tokens`. Both are read so a
 * provider switch doesn't quietly revert to charging cache hits at full price.
 */
function cachedPromptTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as {
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const value = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function chatOpenAICompatible(
  provider: Provider,
  request: LlmChatRequest,
  keys?: ProviderKeys
): Promise<LlmChatResponse> {
  const client = getOpenAICompatibleClient(provider, providerKey(provider, keys));

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: request.system },
  ];
  for (const m of request.messages) {
    if (m.role === 'tool') {
      for (const r of m.results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const response = await client.chat.completions.create({
    model: request.model,
    max_completion_tokens: request.maxTokens ?? 8192,
    messages,
    tools: request.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
  });

  const choice = response.choices[0];
  const toolCalls: LlmToolCall[] = [];
  for (const call of choice?.message?.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = { _raw: call.function.arguments };
    }
    toolCalls.push({ id: call.id, name: call.function.name, input });
  }

  return {
    text: choice?.message?.content ?? '',
    toolCalls,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedInputTokens: cachedPromptTokens(response.usage),
    },
    model: request.model,
    provider,
  };
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

class LlmService {
  async chat(request: LlmChatRequest, keys?: ProviderKeys): Promise<LlmChatResponse> {
    const provider = resolveProvider(request.model);
    if (provider === 'anthropic') return chatAnthropic(request, keys);
    return chatOpenAICompatible(provider, request, keys);
  }

  /**
   * Chat with automatic failover: if the requested model's provider is down
   * (5xx/429/timeout) or unconfigured, retry the same request on the next
   * configured provider. Keeps the Engine running through vendor outages.
   * `keys` are the org's resolved provider keys (falling back to env).
   */
  async chatWithFailover(
    request: LlmChatRequest,
    keys?: ProviderKeys,
    onFailover?: (fromModel: string, toModel: string, reason: string) => void
  ): Promise<LlmChatResponse> {
    const candidates = [request.model, ...failoverChain(request.model, keys)];
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      try {
        return await this.chat({ ...request, model }, keys);
      } catch (err) {
        lastError = err;
        if (!isRetryableProviderError(err)) throw err;
        const next = candidates[i + 1];
        if (next && onFailover) {
          const reason = err instanceof Error ? err.message : 'provider error';
          onFailover(model, next, reason);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('All configured AI providers failed');
  }

  isAnyProviderConfigured(keys?: ProviderKeys): boolean {
    return (Object.keys(PROVIDERS) as Provider[]).some((p) => isProviderConfigured(p, keys));
  }
}

export const llmService = new LlmService();
