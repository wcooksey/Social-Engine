import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { buildEngineSystemPrompt } from './prompts';
import { engineTools, executeTool, ToolContext } from './tools';

export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; summary: string }
  | { type: 'done'; runId: string; messageId?: string }
  | { type: 'error'; message: string };

export interface RunEngineOptions {
  organizationId: string;
  userId?: string;
  trigger: 'USER_CHAT' | 'SCHEDULED_JOB' | 'WEBHOOK';
  objective: string;
  /** Prior chat turns for USER_CHAT runs. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  onEvent?: (event: EngineEvent) => void;
}

export interface RunEngineResult {
  runId: string;
  status: 'COMPLETED' | 'FAILED';
  finalText: string;
  error?: string;
}

function summarizeToolResult(result: unknown): string {
  const json = JSON.stringify(result);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

class EngineService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!config.engine.anthropicApiKey) {
      throw new Error(
        'The Engine is not configured yet: set ANTHROPIC_API_KEY in the backend environment.'
      );
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: config.engine.anthropicApiKey });
    }
    return this.client;
  }

  /**
   * Execute one Engine run: an agent loop (think -> tools -> observe) that is
   * fully persisted as AgentRun + AgentStep rows and streamed via onEvent.
   */
  async run(options: RunEngineOptions): Promise<RunEngineResult> {
    const organization = await prisma.organization.findUnique({
      where: { id: options.organizationId },
    });
    if (!organization) throw new Error('Organization not found');

    const user = options.userId
      ? await prisma.user.findUnique({ where: { id: options.userId } })
      : null;

    const run = await prisma.agentRun.create({
      data: {
        organizationId: options.organizationId,
        userId: options.userId,
        trigger: options.trigger,
        objective: options.objective.slice(0, 2000),
      },
    });
    const ctx: ToolContext = { organizationId: options.organizationId, runId: run.id };
    const emit = options.onEvent ?? (() => undefined);

    let stepIndex = 0;
    const recordStep = async (
      type: string,
      data: { toolName?: string; input?: unknown; output?: unknown }
    ) => {
      await prisma.agentStep.create({
        data: {
          runId: run.id,
          index: stepIndex++,
          type,
          toolName: data.toolName,
          input: data.input === undefined ? undefined : (data.input as never),
          output: data.output === undefined ? undefined : (data.output as never),
        },
      });
    };

    const messages: Anthropic.MessageParam[] = [
      ...(options.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: options.objective },
    ];
    const system = buildEngineSystemPrompt({
      organizationName: organization.name,
      userName: user ? `${user.firstName} ${user.lastName}`.trim() : undefined,
      trigger: options.trigger,
    });

    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const client = this.getClient();

      for (let iteration = 0; iteration < config.engine.maxIterations; iteration++) {
        const response = await client.messages.create({
          model: config.engine.model,
          max_tokens: 4096,
          system,
          tools: engineTools,
          messages,
        });
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        );
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === 'text'
        );

        for (const block of textBlocks) {
          if (!block.text) continue;
          finalText += (finalText ? '\n\n' : '') + block.text;
          emit({ type: 'text', delta: block.text });
          await recordStep('message', { output: block.text });
        }

        if (toolUses.length === 0 || response.stop_reason !== 'tool_use') break;

        messages.push({ role: 'assistant', content: response.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          emit({ type: 'tool_call', toolName: toolUse.name, input: toolUse.input });
          await recordStep('tool_call', { toolName: toolUse.name, input: toolUse.input });

          let result: unknown;
          let isError = false;
          try {
            result = await executeTool(toolUse.name, toolUse.input as Record<string, never>, ctx);
          } catch (err) {
            isError = true;
            result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
          }

          await recordStep('tool_result', { toolName: toolUse.name, output: result });
          emit({ type: 'tool_result', toolName: toolUse.name, summary: summarizeToolResult(result) });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result ?? null),
            is_error: isError,
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          summary: finalText.slice(0, 4000) || options.objective,
          inputTokens,
          outputTokens,
          finishedAt: new Date(),
        },
      });
      return { runId: run.id, status: 'COMPLETED', finalText };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Engine run failed';
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: message.slice(0, 2000),
          inputTokens,
          outputTokens,
          finishedAt: new Date(),
        },
      });
      emit({ type: 'error', message });
      return { runId: run.id, status: 'FAILED', finalText, error: message };
    }
  }
}

export const engineService = new EngineService();
