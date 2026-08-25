import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import * as channels from '../services/channels.service';
import { getOrgConfig } from '../services/settings.service';
import { leadService } from '../services/lead.service';
import { dispatchApprovedSocialDm } from '../services/social-send.service';
import {
  fromNameFor,
  identityFromName,
  resolveSenderIdentity,
  withSignature,
} from '../services/identity.service';
import { unsubscribeUrlFor } from '../services/outbound.service';
import { findKnownPlaceholders } from '../services/placeholder-guard';
import { markMailboxSent, resolveSenderDecision } from '../services/sender.service';

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
): Promise<{ to: string; externalId?: string; mailboxId?: string }> {
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
    // Replies go out under the same identity the outreach did, so a thread
    // never changes sender halfway through.
    const identity = await resolveSenderIdentity(organizationId, {
      lead: { id: lead.id, groupId: lead.groupId, status: lead.status },
      channel: 'EMAIL',
      mailgunDomain: orgConfig.mailgun.domain,
    });
    // Resolved through the sending infrastructure rather than the raw org creds,
    // so this thread keeps its own mailbox and the send is attributed to it.
    // TRANSACTIONAL on purpose: a person has already decided to send this, so a
    // cold-outreach warm-up cap should not hold it — but a paused mailbox or an
    // unverified domain still stops it, and the thread's own sender still wins.
    const decision = await resolveSenderDecision(organizationId, {
      purpose: 'TRANSACTIONAL',
      conversationId: conversation.id,
      playbookId: identity.playbookId,
      preferAddress: identity.email,
      legacy: orgConfig.mailgun,
    });
    const sender = decision.sender;
    if (!sender) {
      throw new AppError(
        decision.reason ||
          'No sending mailbox is available — check Settings → Sending, or add Mailgun credentials.',
        400
      );
    }
    // Known merge tokens only: an operator writing a reply may legitimately use
    // brackets, so this blocks "[first]" and leaves "[see attached]" alone.
    const unfilled = findKnownPlaceholders(`${subject ?? ''}\n${body}`);
    if (unfilled.length) {
      throw new AppError(
        `This message still has placeholders in it: ${unfilled.join(', ')}. Replace them with real ` +
          'values before sending — edit the draft and approve again.',
        400
      );
    }

    const delivery = await channels.sendEmail(
      {
        to: contact.email,
        subject: subject || conversation.subject || 'Re: our conversation',
        // Idempotent: an approved draft already carries the sign-off.
        body: withSignature(body, identity),
        fromName: fromNameFor(identity, sender.displayName),
        fromEmail: sender.fromEmail,
        replyTo: sender.replyTo && sender.replyTo !== sender.fromEmail ? sender.replyTo : undefined,
        // A human approving a send does not make the recipient's opt-out
        // optional. This path shipped without the header while the agent and
        // queue paths carried it, so approval mode — the cautious setting —
        // was the only one sending mail nobody could unsubscribe from.
        unsubscribeUrl: unsubscribeUrlFor(contact.id),
      },
      sender.creds
    );
    if (!delivery.sent) throw new AppError(`Email delivery failed: ${delivery.error}`, 502);
    if (sender.mailboxId) await markMailboxSent(sender.mailboxId);
    return {
      to: contact.email,
      externalId: delivery.externalId,
      mailboxId: sender.mailboxId ?? undefined,
    };
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
        mailboxId: delivery.mailboxId,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    // Anchor the thread's sender if this was its first real send, so later
    // touches stay on the same address.
    if (delivery.mailboxId) {
      await prisma.conversation.updateMany({
        where: { id: conversation.id, mailboxId: null },
        data: { mailboxId: delivery.mailboxId },
      });
    }
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
        mailboxId: delivery.mailboxId,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    // Anchor the thread's sender if this was its first real send, so later
    // touches stay on the same address.
    if (delivery.mailboxId) {
      await prisma.conversation.updateMany({
        where: { id: conversation.id, mailboxId: null },
        data: { mailboxId: delivery.mailboxId },
      });
    }
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

/** Discard a pending draft, or cancel a message still waiting in the send queue. */
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
    // A queued message has not reached anyone yet either, so cancelling one is
    // the same act as discarding a draft from the reader's point of view. A
    // message already claimed by the queue drain ('sending') is past the point
    // of recall and is deliberately excluded.
    const removable = message.status?.startsWith('draft') || message.status === 'scheduled';
    if (!removable) {
      throw new AppError('Only drafts and queued messages can be discarded', 400);
    }

    // The delete carries the same predicate the check did, so a queued message
    // the send queue claimed in the meantime is not deleted out from under a
    // send that is already on the wire.
    const removed = await prisma.message.deleteMany({
      where: {
        id: message.id,
        OR: [{ status: { startsWith: 'draft' } }, { status: 'scheduled' }],
      },
    });
    if (removed.count === 0) {
      throw new AppError('That message is already being sent and can no longer be cancelled', 409);
    }
    res.json({ success: true, data: null });
  })
);

export default router;
