import { prisma } from '../config/database';
import { config } from '../config/environment';
import { isEmailConfigured, isSmsConfigured, isVoiceConfigured } from '../services/channels.service';
import { formatPlaybooksForPrompt, getActivePlaybooks } from '../services/playbook.service';
import { getOrgConfig, getPlatformEngineConfig } from '../services/settings.service';
import { estimateCostUsd, ProviderKeys } from './llm/catalog';
import { buildEngineSystemPrompt } from './prompts';
import { LlmMessage, LlmToolDefinition, llmService } from './llm/llm.service';
import { AgentRole, roleAllowsTool, rolePersona } from './roles';
import { engineTools, executeTool, ToolContext } from './tools';

export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; summary: string }
  | { type: 'model_failover'; fromModel: string; toModel: string; reason: string }
  | { type: 'done'; runId: string; messageId?: string }
  | { type: 'error'; message: string };

export interface RunEngineOptions {
  organizationId: string;
  userId?: string;
  trigger: 'USER_CHAT' | 'SCHEDULED_JOB' | 'WEBHOOK';
  /** Specialist role driving this run (defaults to the generalist Coordinator). */
  role?: AgentRole;
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

const llmTools: LlmToolDefinition[] = engineTools.map((t) => ({
  name: t.name,
  description: t.description ?? '',
  inputSchema: t.input_schema as Record<string, unknown>,
}));

function summarizeToolResult(result: unknown): string {
  const json = JSON.stringify(result);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

class EngineService {
  /**
   * Execute one Engine run: a provider-agnostic agent loop (think -> tools ->
   * observe) persisted as AgentRun + AgentStep rows and streamed via onEvent.
   * The model comes from the organization's engineModel setting; provider
   * outages fail over automatically to the next configured provider.
   */
  async run(options: RunEngineOptions): Promise<RunEngineResult> {
    const organization = await prisma.organization.findUnique({
      where: { id: options.organizationId },
    });
    if (!organization) throw new Error('Organization not found');

    const user = options.userId
      ? await prisma.user.findUnique({ where: { id: options.userId } })
      : null;

    const model = organization.engineModel || config.engine.model;
    const role: AgentRole = options.role || 'COORDINATOR';
    // Scope the tools to the role — a Researcher can't send, an SDR can't dial.
    const roleTools = llmTools.filter((t) => roleAllowsTool(role, t.name));

    const run = await prisma.agentRun.create({
      data: {
        organizationId: options.organizationId,
        userId: options.userId,
        trigger: options.trigger,
        role,
        objective: options.objective.slice(0, 2000),
        model,
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

    const messages: LlmMessage[] = [
      ...(options.history ?? []).map(
        (m): LlmMessage => ({ role: m.role, content: m.content })
      ),
      { role: 'user', content: options.objective },
    ];
    const orgConfig = await getOrgConfig(options.organizationId);
    const providerKeys: ProviderKeys = orgConfig.providerKeys;

    const playbooks = await getActivePlaybooks(options.organizationId);
    const system = buildEngineSystemPrompt({
      organizationName: organization.name,
      userName: user ? `${user.firstName} ${user.lastName}`.trim() : undefined,
      trigger: options.trigger,
      rolePersona: rolePersona(role),
      playbooksText: formatPlaybooksForPrompt(playbooks),
      channels: {
        email: isEmailConfigured(orgConfig.mailgun),
        sms: isSmsConfigured(orgConfig.twilio),
        voice: isVoiceConfigured(orgConfig.vapi),
      },
    });

    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let servedByModel = model;

    try {
      if (!llmService.isAnyProviderConfigured(providerKeys)) {
        throw new Error(
          'The Engine is not configured yet: add at least one AI provider API key in Settings → Integrations (Anthropic, OpenAI, Gemini, xAI, or DeepSeek).'
        );
      }

      const maxIterations = (await getPlatformEngineConfig()).maxIterations;
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const response = await llmService.chatWithFailover(
          { model, system, messages, tools: roleTools, maxTokens: 8192 },
          providerKeys,
          (fromModel, toModel, reason) => {
            emit({ type: 'model_failover', fromModel, toModel, reason });
            void recordStep('model_failover', {
              output: { fromModel, toModel, reason },
            });
          }
        );
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
        // Price against the model that actually served (matters on failover).
        costUsd += estimateCostUsd(
          response.model,
          response.usage.inputTokens,
          response.usage.outputTokens
        );
        servedByModel = response.model;

        if (response.text) {
          finalText += (finalText ? '\n\n' : '') + response.text;
          emit({ type: 'text', delta: response.text });
          await recordStep('message', { output: response.text });
        }

        if (response.toolCalls.length === 0) break;

        messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
        });
        const results: { toolCallId: string; name: string; content: string; isError?: boolean }[] =
          [];

        for (const call of response.toolCalls) {
          emit({ type: 'tool_call', toolName: call.name, input: call.input });
          await recordStep('tool_call', { toolName: call.name, input: call.input });

          let result: unknown;
          let isError = false;
          try {
            result = await executeTool(call.name, call.input as Record<string, never>, ctx);
          } catch (err) {
            isError = true;
            result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
          }

          await recordStep('tool_result', { toolName: call.name, output: result });
          emit({ type: 'tool_result', toolName: call.name, summary: summarizeToolResult(result) });

          results.push({
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(result ?? null),
            isError,
          });
        }
        messages.push({ role: 'tool', results });
      }

      // Increment (not set): browser-agent tool calls attribute their own
      // usage to this run mid-flight, and that must survive the final write.
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          summary: finalText.slice(0, 4000) || options.objective,
          model: servedByModel,
          inputTokens: { increment: inputTokens },
          outputTokens: { increment: outputTokens },
          costUsd: { increment: costUsd },
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
          model: servedByModel,
          inputTokens: { increment: inputTokens },
          outputTokens: { increment: outputTokens },
          costUsd: { increment: costUsd },
          finishedAt: new Date(),
        },
      });
      emit({ type: 'error', message });
      return { runId: run.id, status: 'FAILED', finalText, error: message };
    }
  }
}

export const engineService = new EngineService();
