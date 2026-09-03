import crypto from 'crypto';
import { prisma } from '../config/database';
import { engineTools } from '../engine/tools';
import { buildEngineSystemPrompt } from '../engine/prompts';
import { formatPlaybooksForPrompt, getActivePlaybooks } from './playbook.service';
import { isSmsConfigured, isVoiceConfigured } from './channels.service';
import { hasAnyEmailTransport } from './sender.service';
import { getOrgConfig, resolveOrg } from './settings.service';

/**
 * ElevenLabs Agents integration for the Engine's live voice mode.
 *
 * Each organization gets one auto-provisioned ElevenLabs agent that mirrors
 * the Engine: same system prompt, and every engine tool exposed as an
 * ElevenLabs *client tool*. The browser holds the conversation (mic/audio via
 * the ElevenLabs SDK); when the agent calls a tool, the browser forwards it to
 * our authenticated /api/voice endpoint, which executes it through the same
 * org-scoped executeTool() path as regular Engine runs.
 *
 * The API key never reaches the browser — sessions are opened with short-lived
 * signed URLs minted here.
 */

const API_BASE = 'https://api.elevenlabs.io';
/** Hidden (non-registry) OrgSetting key holding provisioning state as JSON. */
const AGENT_STATE_KEY = 'ELEVENLABS_AGENT_STATE';
const DEFAULT_LLM = 'claude-sonnet-4-5';
/** ElevenLabs kills a pending client tool after this many seconds (their max). */
const TOOL_TIMEOUT_SECS = 120;

interface AgentState {
  agentId: string;
  toolIds: string[];
  toolsHash: string;
}

const VOICE_PROMPT_ADDENDUM = `

## Voice conversation (this session)
You are in a LIVE VOICE conversation with the user — they hear your words spoken aloud.
- Keep replies short and conversational: 1-3 spoken sentences. No markdown, no bullet lists, no URLs read out character by character.
- Before a slow tool call, say a brief heads-up like "one sec, let me pull that up" so the user isn't sitting in silence.
- Tool calls run against the REAL system with full effect (leads, emails, campaigns). Confirm out loud before anything irreversible like sending messages or placing calls.
- If a tool takes too long and times out, tell the user the work is still running and they can check the dashboard.
- Numbers, emails, and IDs: summarize rather than reading them out in full unless asked.`;

async function elFetch<T = any>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'xi-api-key': apiKey,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs API ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * ElevenLabs rejects tool schemas where any property lacks a description
 * ("Must set one of: description, dynamic_variable, ..."), while our engine
 * schemas leave self-explanatory fields bare. Recursively fill in fallbacks.
 */
function describeSchema(schema: unknown, fallback: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, any> = { ...(schema as Record<string, any>) };
  if (!out.description) out.description = fallback;
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, describeSchema(value, key)])
    );
  }
  if (out.items) out.items = describeSchema(out.items, `${fallback} item`);
  return out;
}

/** Every engine tool, expressed as an ElevenLabs client-tool config. */
function buildClientToolConfigs(): Record<string, unknown>[] {
  return engineTools.map((t) => ({
    type: 'client',
    name: t.name,
    description: (t.description ?? '').slice(0, 950),
    expects_response: true,
    response_timeout_secs: TOOL_TIMEOUT_SECS,
    parameters: describeSchema(t.input_schema, t.name),
  }));
}

async function readState(organizationId: string): Promise<AgentState | null> {
  const row = await prisma.orgSetting.findUnique({
    where: { organizationId_key: { organizationId, key: AGENT_STATE_KEY } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as AgentState;
    return parsed.agentId !== undefined ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(organizationId: string, state: AgentState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.orgSetting.upsert({
    where: { organizationId_key: { organizationId, key: AGENT_STATE_KEY } },
    create: { organizationId, key: AGENT_STATE_KEY, value, isSecret: false },
    update: { value, isSecret: false },
  });
}

export async function isElevenLabsConfigured(organizationId: string): Promise<boolean> {
  return !!(await resolveOrg(organizationId, 'ELEVENLABS_API_KEY'));
}

async function buildVoicePrompt(organizationId: string, organizationName: string): Promise<string> {
  const orgConfig = await getOrgConfig(organizationId);
  const playbooks = await getActivePlaybooks(organizationId);
  return (
    buildEngineSystemPrompt({
      organizationName,
      trigger: 'USER_CHAT',
      playbooksText: formatPlaybooksForPrompt(playbooks),
      channels: {
        email: await hasAnyEmailTransport(organizationId, orgConfig.mailgun),
        sms: isSmsConfigured(orgConfig.twilio),
        voice: isVoiceConfigured(orgConfig.vapi),
      },
    }) + VOICE_PROMPT_ADDENDUM
  );
}

/**
 * Ensure the org's ElevenLabs agent exists and is up to date. Tools are
 * recreated only when their definitions change (hashed); the agent config
 * (prompt, LLM, voice) is pushed on every call so Settings changes take
 * effect on the next session.
 */
export async function ensureVoiceAgent(organizationId: string): Promise<{ agentId: string; apiKey: string }> {
  const [apiKey, voiceId, llm] = await Promise.all([
    resolveOrg(organizationId, 'ELEVENLABS_API_KEY'),
    resolveOrg(organizationId, 'ELEVENLABS_VOICE_ID'),
    resolveOrg(organizationId, 'ELEVENLABS_LLM'),
  ]);
  if (!apiKey) {
    throw new Error('ElevenLabs is not configured — add an ElevenLabs API key in Settings → Integrations.');
  }

  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!organization) throw new Error('Organization not found');

  const toolConfigs = buildClientToolConfigs();
  const toolsHash = crypto.createHash('sha256').update(JSON.stringify(toolConfigs)).digest('hex');

  let state = await readState(organizationId);
  const staleToolIds = state && state.toolsHash !== toolsHash ? state.toolIds : [];

  if (!state || state.toolsHash !== toolsHash) {
    // (Re)create the full tool set. Chunked so we don't burst-fire ~55 calls.
    const toolIds: string[] = [];
    try {
      const chunkSize = 10;
      for (let i = 0; i < toolConfigs.length; i += chunkSize) {
        const chunk = toolConfigs.slice(i, i + chunkSize);
        const created = await Promise.all(
          chunk.map((tool_config) =>
            elFetch<{ id: string }>(apiKey, '/v1/convai/tools', { method: 'POST', body: { tool_config } })
          )
        );
        toolIds.push(...created.map((c) => c.id));
      }
    } catch (err) {
      // Don't leave a half-created tool set orphaned in the workspace.
      await Promise.allSettled(
        toolIds.map((id) => elFetch(apiKey, `/v1/convai/tools/${id}`, { method: 'DELETE' }))
      );
      throw err;
    }
    state = { agentId: state?.agentId ?? '', toolIds, toolsHash };
  }

  const prompt = await buildVoicePrompt(organizationId, organization.name);
  const conversationConfig = {
    agent: {
      first_message: "Hey, you're live with the Engine. What should we work on?",
      language: 'en',
      prompt: {
        prompt,
        llm: llm || DEFAULT_LLM,
        tool_ids: state.toolIds,
      },
    },
    ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
  };

  if (state.agentId) {
    try {
      await elFetch(apiKey, `/v1/convai/agents/${state.agentId}`, {
        method: 'PATCH',
        body: { conversation_config: conversationConfig },
      });
    } catch {
      // Agent was deleted from the ElevenLabs dashboard — recreate it.
      state.agentId = '';
    }
  }
  if (!state.agentId) {
    const created = await elFetch<{ agent_id: string }>(apiKey, '/v1/convai/agents/create', {
      method: 'POST',
      body: {
        name: `Social Engine — ${organization.name}`,
        conversation_config: conversationConfig,
      },
    });
    state.agentId = created.agent_id;
  }

  await saveState(organizationId, state);

  // Best-effort cleanup of superseded tool versions (after the agent no
  // longer references them).
  for (const id of staleToolIds) {
    try {
      await elFetch(apiKey, `/v1/convai/tools/${id}`, { method: 'DELETE' });
    } catch {
      // Non-fatal — orphaned tools just linger in the ElevenLabs workspace.
    }
  }

  return { agentId: state.agentId, apiKey };
}

/** Mint a short-lived signed WebSocket URL for a browser voice session. */
export async function getVoiceSessionUrl(organizationId: string): Promise<string> {
  const { agentId, apiKey } = await ensureVoiceAgent(organizationId);
  const res = await elFetch<{ signed_url: string }>(
    apiKey,
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`
  );
  return res.signed_url;
}
