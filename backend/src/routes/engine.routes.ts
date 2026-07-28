import { Response, Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { engineService } from '../engine/engine.service';
import * as runRegistry from '../engine/run-registry';

const router = Router();

router.get(
  '/chats',
  asyncHandler(async (req, res) => {
    const chats = await prisma.engineChat.findMany({
      where: { organizationId: req.user!.organizationId, userId: req.user!.userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, updatedAt: true, createdAt: true },
    });
    res.json({ success: true, data: chats });
  })
);

router.post(
  '/chats',
  asyncHandler(async (req, res) => {
    const chat = await prisma.engineChat.create({
      data: {
        organizationId: req.user!.organizationId,
        userId: req.user!.userId,
        title: req.body?.title || 'New conversation',
      },
    });
    res.status(201).json({ success: true, data: chat });
  })
);

router.get(
  '/chats/:id',
  asyncHandler(async (req, res) => {
    const chat = await prisma.engineChat.findFirst({
      where: {
        id: req.params.id,
        organizationId: req.user!.organizationId,
        userId: req.user!.userId,
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!chat) throw new AppError('Chat not found', 404);
    res.json({ success: true, data: chat });
  })
);

router.delete(
  '/chats/:id',
  asyncHandler(async (req, res) => {
    const chat = await prisma.engineChat.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId, userId: req.user!.userId },
    });
    if (!chat) throw new AppError('Chat not found', 404);
    await prisma.engineChat.delete({ where: { id: chat.id } });
    res.json({ success: true, data: null });
  })
);

function sseWrite(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Start an Engine run for this chat. Returns the runId IMMEDIATELY and lets the
 * run continue in the background — the run is no longer tied to this request,
 * so closing the page (or navigating away) doesn't kill it. Follow it via
 * GET /runs/:runId/stream, which can be attached and re-attached at will.
 */
router.post(
  '/chats/:id/messages',
  asyncHandler(async (req, res) => {
    const content: string = (req.body?.content || '').trim();
    if (!content) throw new AppError('content is required');

    const chat = await prisma.engineChat.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId, userId: req.user!.userId },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 40 } },
    });
    if (!chat) throw new AppError('Chat not found', 404);

    // One run per chat at a time, so a stray double-send can't fork the thread.
    const existing = runRegistry.findRunForChat(req.user!.organizationId, chat.id);
    if (existing) {
      throw new AppError('This conversation already has a run in progress', 409);
    }

    await prisma.engineChatMessage.create({
      data: { chatId: chat.id, role: 'user', content },
    });
    const titleUpdate = chat.messages.length === 0 ? { title: content.slice(0, 60) } : {};
    await prisma.engineChat.update({
      where: { id: chat.id },
      data: { updatedAt: new Date(), ...titleUpdate },
    });

    const organizationId = req.user!.organizationId;
    const userId = req.user!.userId;

    const runId = await new Promise<string>((resolve, reject) => {
      let settled = false;
      void engineService
        .run({
          organizationId,
          userId,
          trigger: 'USER_CHAT',
          objective: content,
          chatId: chat.id,
          watch: req.body?.watch === true,
          history: chat.messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          onStart: (id) => {
            settled = true;
            resolve(id);
          },
        })
        .then(async (result) => {
          // Persist the reply here rather than in the request handler — the
          // request is long gone by the time a big run finishes.
          const assistantMessage = await prisma.engineChatMessage.create({
            data: {
              chatId: chat.id,
              role: 'assistant',
              content:
                result.finalText ||
                (result.status === 'CANCELLED'
                  ? '(stopped)'
                  : result.error
                    ? `The Engine hit an error: ${result.error}`
                    : '(no response)'),
              agentRunId: result.runId,
            },
          });
          runRegistry.publish(result.runId, {
            type: 'done',
            runId: result.runId,
            messageId: assistantMessage.id,
          });
        })
        .catch((err) => {
          if (!settled) reject(err);
        });
    });

    res.status(202).json({ success: true, data: { runId, chatId: chat.id } });
  })
);

/**
 * Attach to a run's event stream. `fromIndex` resumes where a previous
 * connection left off, so navigating away and back replays only what was
 * missed. Runs the registry no longer holds (finished long ago, or a restart)
 * are replayed from their persisted AgentStep rows instead.
 */
router.get(
  '/runs/:runId/stream',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const fromIndex = Number(req.query.fromIndex) || 0;

    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.runId, organizationId },
      select: { id: true, status: true },
    });
    if (!run) throw new AppError('Run not found', 404);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const unsubscribe = runRegistry.subscribe(req.params.runId, organizationId, fromIndex, (item) =>
      sseWrite(res, item)
    );

    if (!unsubscribe) {
      // Not live: rebuild the timeline from the durable record and close.
      const steps = await prisma.agentStep.findMany({
        where: { runId: run.id },
        orderBy: { index: 'asc' },
        take: 500,
      });
      let index = 0;
      for (const step of steps) {
        const event =
          step.type === 'tool_call'
            ? { type: 'tool_call' as const, toolName: step.toolName || '', input: step.input }
            : step.type === 'tool_result'
              ? {
                  type: 'tool_result' as const,
                  toolName: step.toolName || '',
                  summary: JSON.stringify(step.output ?? null).slice(0, 300),
                }
              : { type: 'text' as const, delta: String(step.output ?? '') };
        sseWrite(res, { index: index++, event });
      }
      sseWrite(res, {
        index: index++,
        event: { type: 'run_status', runId: run.id, phase: 'finished', watch: false },
      });
      sseWrite(res, { index, event: { type: 'done', runId: run.id } });
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  })
);

/** Pause / resume / cancel / step a live run, or toggle watch mode on it. */
router.post(
  '/runs/:runId/control',
  asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '');
    const allowed = ['pause', 'resume', 'cancel', 'step', 'watch_on', 'watch_off'];
    if (!allowed.includes(action)) {
      throw new AppError(`action must be one of: ${allowed.join(', ')}`);
    }
    const result = runRegistry.control(
      req.params.runId,
      req.user!.organizationId,
      action as runRegistry.RunControlAction
    );
    if (!result) throw new AppError('Run is not currently live', 404);
    res.json({
      success: true,
      data: {
        ...result,
        // Stopping lands at the next checkpoint, never mid-tool-call, so a
        // long-running browser step finishes before the run actually halts.
        note:
          action === 'cancel'
            ? 'Stopping after the current step finishes.'
            : action === 'pause'
              ? 'Pausing at the next step boundary.'
              : undefined,
      },
    });
  })
);

/** Everything in flight for this org — the fleet view's data source. */
router.get(
  '/runs/active',
  asyncHandler(async (req, res) => {
    const runs = runRegistry.listRuns(req.user!.organizationId, req.query.includeFinished === 'true');
    res.json({ success: true, data: runs });
  })
);

/** The live run for a chat, if any — lets the UI reattach when it reloads. */
router.get(
  '/chats/:id/live',
  asyncHandler(async (req, res) => {
    const live = runRegistry.findRunForChat(req.user!.organizationId, req.params.id);
    res.json({ success: true, data: live });
  })
);

export default router;
