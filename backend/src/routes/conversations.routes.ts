import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

const router = Router();

/** Unified inbox: recent conversations across all leads, filterable by channel. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = 25;
    const where: Prisma.ConversationWhereInput = {
      organizationId: req.user!.organizationId,
      ...(req.query.channel ? { channel: req.query.channel as never } : {}),
      ...(req.query.leadId ? { leadId: req.query.leadId as string } : {}),
      ...(req.query.search
        ? { lead: { companyName: { contains: req.query.search as string, mode: 'insensitive' } } }
        : {}),
    };

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, status: true } },
          contact: { select: { id: true, firstName: true, lastName: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { messages: true } },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.conversation.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        conversations: conversations.map((c) => ({
          id: c.id,
          channel: c.channel,
          subject: c.subject,
          lastMessageAt: c.lastMessageAt,
          messageCount: c._count.messages,
          lead: c.lead,
          contact: c.contact
            ? { id: c.contact.id, name: `${c.contact.firstName} ${c.contact.lastName || ''}`.trim() }
            : null,
          lastMessage: c.messages[0]
            ? {
                direction: c.messages[0].direction,
                body: c.messages[0].body,
                status: c.messages[0].status,
                createdAt: c.messages[0].createdAt,
              }
            : null,
        })),
        total,
        page,
        pageSize,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      include: {
        lead: { select: { id: true, companyName: true, status: true } },
        contact: true,
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversation) throw new AppError('Conversation not found', 404);
    res.json({ success: true, data: conversation });
  })
);

export default router;
