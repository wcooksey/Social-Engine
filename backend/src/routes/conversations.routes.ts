import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import * as channels from '../services/channels.service';
import { getOrgConfig } from '../services/settings.service';
import { leadService } from '../services/lead.service';
import { dispatchApprovedSocialDm } from '../services/social-send.service';

const router = Router();

/**
 * Resolve where an outbound message on this conversation should go and send
 * it with the org's channel creds. Shared by manual replies and draft
 * approvals. Throws AppError with a user-readable reason on failure.
 */
async function deliverOnConversation(
  organizationId: string,
  conversation: {
    id: string;
    channel: string;
    leadId: string;
    contactId: string | null;
    subject: string | null;
  },
  body: string,
  subject?: string
): Promise<{ to: string; externalId?: string }> {
  const lead = await prisma.lead.findFirst({
    where: { id: conversation.leadId, organizationId },
  });
  if (!lead) throw new AppError('Lead not found', 404);
  if (lead.doNotContact) {
    throw new AppError('This lead has opted out of being contacted (do-not-contact).', 400);
  }

  const contact = conversation.contactId
    ? await prisma.contact.findFirst({ where: { id: conversation.contactId, organizationId } })
    : await prisma.contact.findFirst({
        where: {
          leadId: lead.id,
          optedOut: false,
          ...(conversation.channel === 'EMAIL' ? { email: { not: null } } : { phone: { not: null } }),
        },
        orderBy: { isPrimary: 'desc' },
      });

  const orgConfig = await getOrgConfig(organizationId);

  if (conversation.channel === 'EMAIL') {
    if (!contact?.email) throw new AppError('No contact with an email address on this lead.', 400);
    if (contact.optedOut) throw new AppError('This contact has opted out.', 400);
    if (!channels.isEmailConfigured(orgConfig.mailgun)) {
      throw new AppError('Email channel (Mailgun) is not configured — add it in Settings → Integrations.', 400);
    }
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    const delivery = await channels.sendEmail(
      {
        to: contact.email,
        subject: subject || conversation.subject || 'Re: our conversation',
        body,
        fromName: org?.name,
      },
      orgConfig.mailgun
    );
    if (!delivery.sent) throw new AppError(`Email delivery failed: ${delivery.error}`, 502);
    return { to: contact.email, externalId: delivery.externalId };
  }

  if (conversation.channel === 'SMS') {
    if (!contact?.phone) throw new AppError('No contact with a phone number on this lead.', 400);
    if (contact.optedOut) throw new AppError('This contact has opted out.', 400);
    if (!channels.isSmsConfigured(orgConfig.twilio)) {
      throw new AppError('SMS channel (Twilio) is not configured — add it in Settings → Integrations.', 400);
    }
    const delivery = await channels.sendSms({ to: contact.phone, body }, orgConfig.twilio);
    if (!delivery.sent) throw new AppError(`SMS delivery failed: ${delivery.error}`, 502);
    return { to: contact.phone, externalId: delivery.externalId };
  }

  throw new AppError(
    'Social DMs are sent by the browser agent. Ask the Engine to send it (with social autonomy enabled in Settings), or send it manually on the platform.',
    400
  );
}

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

/** Manual human reply on a conversation (EMAIL/SMS send with org creds). */
router.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) throw new AppError('body is required');

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!conversation) throw new AppError('Conversation not found', 404);

    const delivery = await deliverOnConversation(
      req.user!.organizationId,
      conversation,
      body,
      req.body?.subject
    );

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        body,
        status: 'sent',
        sentAt: new Date(),
        externalId: delivery.externalId,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    await leadService.logActivity({
      organizationId: req.user!.organizationId,
      leadId: conversation.leadId,
      type: conversation.channel === 'EMAIL' ? 'EMAIL_SENT' : 'SMS_SENT',
      summary: `Manual ${conversation.channel.toLowerCase()} reply sent to ${delivery.to}`,
      payload: { messageId: message.id, manual: true },
    });

    res.status(201).json({ success: true, data: message });
  })
);

/** Approve a pending draft: sends it (optionally with an edited body) and marks it sent. */
router.post(
  '/:id/messages/:messageId/send',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!conversation) throw new AppError('Conversation not found', 404);

    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id },
    });
    if (!message) throw new AppError('Message not found', 404);
    if (!message.status?.startsWith('draft')) {
      throw new AppError('Only drafts can be approved and sent', 400);
    }

    const body = String(req.body?.body ?? message.body).trim();
    if (!body) throw new AppError('body cannot be empty');

    // Social DMs go out through the browser agent in the background — the
    // request returns immediately with a 'sending' status the UI can poll.
    if (conversation.channel === 'SOCIAL') {
      const lead = await prisma.lead.findFirst({
        where: { id: conversation.leadId, organizationId: req.user!.organizationId },
      });
      if (lead?.doNotContact) throw new AppError('This lead has opted out of being contacted.', 400);
      const updated = await prisma.message.update({
        where: { id: message.id },
        data: { body, status: 'sending' },
      });
      void dispatchApprovedSocialDm(message.id);
      res.json({ success: true, data: updated });
      return;
    }

    const delivery = await deliverOnConversation(
      req.user!.organizationId,
      conversation,
      body,
      req.body?.subject
    );

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: {
        body,
        status: 'sent',
        sentAt: new Date(),
        externalId: delivery.externalId,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    await leadService.logActivity({
      organizationId: req.user!.organizationId,
      leadId: conversation.leadId,
      type: conversation.channel === 'EMAIL' ? 'EMAIL_SENT' : 'SMS_SENT',
      summary: `Draft approved and sent to ${delivery.to}`,
      payload: { messageId: message.id, approvedDraft: true },
    });

    res.json({ success: true, data: updated });
  })
);

/** Discard a pending draft. */
router.delete(
  '/:id/messages/:messageId',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!conversation) throw new AppError('Conversation not found', 404);

    const message = await prisma.message.findFirst({
      where: { id: req.params.messageId, conversationId: conversation.id },
    });
    if (!message) throw new AppError('Message not found', 404);
    if (!message.status?.startsWith('draft')) {
      throw new AppError('Only drafts can be discarded', 400);
    }

    await prisma.message.delete({ where: { id: message.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
