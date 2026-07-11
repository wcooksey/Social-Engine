import { Response, Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { EngineEvent, engineService } from '../engine/engine.service';

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

function sseWrite(res: Response, event: EngineEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Send a message to the Engine. Streams the run back as Server-Sent Events:
 * text deltas, tool calls/results, then a final `done` event.
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

    await prisma.engineChatMessage.create({
      data: { chatId: chat.id, role: 'user', content },
    });
    const titleUpdate =
      chat.messages.length === 0 ? { title: content.slice(0, 60) } : {};
    await prisma.engineChat.update({
      where: { id: chat.id },
      data: { updatedAt: new Date(), ...titleUpdate },
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

    try {
      const result = await engineService.run({
        organizationId: req.user!.organizationId,
        userId: req.user!.userId,
        trigger: 'USER_CHAT',
        objective: content,
        history: chat.messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        onEvent: (event) => sseWrite(res, event),
      });

      const assistantMessage = await prisma.engineChatMessage.create({
        data: {
          chatId: chat.id,
          role: 'assistant',
          content:
            result.finalText ||
            (result.error ? `The Engine hit an error: ${result.error}` : '(no response)'),
          agentRunId: result.runId,
        },
      });
      sseWrite(res, { type: 'done', runId: result.runId, messageId: assistantMessage.id });
    } catch (err) {
      sseWrite(res, {
        type: 'error',
        message: err instanceof Error ? err.message : 'Engine run failed',
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  })
);

export default router;
