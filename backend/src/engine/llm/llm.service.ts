import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { isProviderConfigured, PROVIDERS, Provider, failoverChain, resolveProvider } from './catalog';

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
  usage: { inputTokens: number; outputTokens: number };
  /** Model that actually served the request (differs from request on failover). */
  model: string;
  provider: Provider;
}

// ---------------------------------------------------------------------------
// Clients (cached per provider)
// ---------------------------------------------------------------------------

const anthropicClients = new Map<string, Anthropic>();
const openaiClients = new Map<string, OpenAI>();

function getAnthropicClient(): Anthropic {
  const apiKey = PROVIDERS.anthropic.apiKey();
  if (!apiKey) throw new LlmNotConfiguredError('anthropic');
  let client = anthropicClients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    anthropicClients.set(apiKey, client);
  }
  return client;
}

function getOpenAICompatibleClient(provider: Provider): OpenAI {
  const info = PROVIDERS[provider];
  const apiKey = info.apiKey();
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
      `${PROVIDERS[provider].label} is not configured — set the API key in the backend environment.`
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

async function chatAnthropic(request: LlmChatRequest): Promise<LlmChatResponse> {
  const client = getAnthropicClient();

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

  const response = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    system: request.system,
    tools: request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
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
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    model: request.model,
    provider: 'anthropic',
  };
}

async function chatOpenAICompatible(
  provider: Provider,
  request: LlmChatRequest
): Promise<LlmChatResponse> {
  const client = getOpenAICompatibleClient(provider);

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
    },
    model: request.model,
    provider,
  };
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

class LlmService {
  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const provider = resolveProvider(request.model);
    if (provider === 'anthropic') return chatAnthropic(request);
    return chatOpenAICompatible(provider, request);
  }

  /**
   * Chat with automatic failover: if the requested model's provider is down
   * (5xx/429/timeout) or unconfigured, retry the same request on the next
   * configured provider. Keeps the Engine running through vendor outages.
   */
  async chatWithFailover(
    request: LlmChatRequest,
    onFailover?: (fromModel: string, toModel: string, reason: string) => void
  ): Promise<LlmChatResponse> {
    const candidates = [request.model, ...failoverChain(request.model)];
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      try {
        return await this.chat({ ...request, model });
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

  isAnyProviderConfigured(): boolean {
    return (Object.keys(PROVIDERS) as Provider[]).some(isProviderConfigured);
  }
}

export const llmService = new LlmService();
