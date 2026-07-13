import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { engineTools, executeTool, ToolContext } from '../engine/tools';
import {
  getVoiceSessionUrl,
  isElevenLabsConfigured,
} from '../services/elevenlabs.service';
import { resolveOrg } from '../services/settings.service';

/**
 * Live voice mode for the Engine (ElevenLabs Agents).
 *
 * The browser talks to ElevenLabs directly over a signed WebSocket; this
 * router only (1) mints those signed URLs, (2) executes the agent's client
 * tool calls through the same org-scoped executeTool() path as regular Engine
 * runs (audited as AgentRun/AgentStep), and (3) persists the transcript as an
 * Engine chat when the session ends.
 */

const router = Router();

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const available = await isElevenLabsConfigured(req.user!.organizationId);
    res.json({ success: true, data: { available } });
  })
);

/**
 * Open a voice session: provision/update the org's ElevenLabs agent, mint a
 * signed URL, and create the AgentRun that audits the session's tool calls.
 */
router.post(
  '/session',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const signedUrl = await getVoiceSessionUrl(organizationId);
    const llm = (await resolveOrg(organizationId, 'ELEVENLABS_LLM')) || 'claude-sonnet-4-5';

    const run = await prisma.agentRun.create({
      data: {
        organizationId,
        userId: req.user!.userId,
        trigger: 'USER_CHAT',
        role: 'COORDINATOR',
        objective: 'Live voice conversation',
        model: `elevenlabs/${llm}`,
      },
    });

    res.json({
      success: true,
      data: {
        signedUrl,
        runId: run.id,
        toolNames: engineTools.map((t) => t.name),
      },
    });
  })
);

/** Look up a voice-session run, enforcing org + user ownership. */
async function findSessionRun(runId: string, organizationId: string, userId: string) {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, organizationId, userId, trigger: 'USER_CHAT' },
  });
  if (!run) throw new AppError('Voice session not found', 404);
  return run;
}

/**
 * Execute one client tool call on behalf of the voice agent. The result is
 * returned to the browser, which hands it back to the agent as the tool
 * response.
 */
router.post(
  '/session/:runId/tool',
  asyncHandler(async (req, res) => {
    const run = await findSessionRun(req.params.runId, req.user!.organizationId, req.user!.userId);
    if (run.status !== 'RUNNING') throw new AppError('Voice session has ended', 409);

    const name: string = req.body?.name;
    const input: Record<string, unknown> = req.body?.input ?? {};
    if (!name || typeof name !== 'string') throw new AppError('name is required');

    const ctx: ToolContext = { organizationId: run.organizationId, runId: run.id };
    const baseIndex = await prisma.agentStep.count({ where: { runId: run.id } });
    await prisma.agentStep.create({
      data: { runId: run.id, index: baseIndex, type: 'tool_call', toolName: name, input: input as never },
    });

    let result: unknown;
    let isError = false;
    try {
      result = await executeTool(name, input as Record<string, never>, ctx);
    } catch (err) {
      isError = true;
      result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
    }

    await prisma.agentStep.create({
      data: {
        runId: run.id,
        index: baseIndex + 1,
        type: 'tool_result',
        toolName: name,
        output: (result ?? null) as never,
      },
    });

    res.json({ success: true, data: { result: result ?? null, isError } });
  })
);

/**
 * Close a voice session: mark the run finished and persist the spoken
 * transcript as an Engine chat so it shows up in conversation history.
 */
router.post(
  '/session/:runId/end',
  asyncHandler(async (req, res) => {
    const run = await findSessionRun(req.params.runId, req.user!.organizationId, req.user!.userId);
    const transcript: { role: string; content: string }[] = Array.isArray(req.body?.transcript)
      ? req.body.transcript.filter(
          (m: any) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.trim() !== ''
        )
      : [];

    let chatId: string | null = null;
    if (transcript.length) {
      const firstUser = transcript.find((m) => m.role === 'user')?.content ?? '';
      const chat = await prisma.engineChat.create({
        data: {
          organizationId: run.organizationId,
          userId: req.user!.userId,
          title: `🎙 ${(firstUser || 'Voice conversation').slice(0, 60)}`,
          messages: {
            create: transcript.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.role === 'assistant' ? { agentRunId: run.id } : {}),
            })),
          },
        },
      });
      chatId = chat.id;
    }

    if (run.status === 'RUNNING') {
      const summary =
        transcript
          .map((m) => `${m.role === 'user' ? 'User' : 'Engine'}: ${m.content}`)
          .join('\n')
          .slice(0, 4000) || 'Voice conversation (no transcript)';
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', summary, finishedAt: new Date() },
      });
    }

    res.json({ success: true, data: { chatId } });
  })
);

export default router;
