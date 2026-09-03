import { prisma } from '../config/database';
import * as channels from './channels.service';
import type { SendEmailOptions, SendResult } from './channels.service';
import {
  markGmailSent,
  releaseGmailSend,
  reserveGmailSend,
  sendViaGmail,
} from './gmail.service';
import type { ResolvedSender } from './sender.service';
import { markMailboxSent, releaseSend, reserveSend } from './sender.service';

/**
 * One way to put an email on the wire, whichever transport carries it.
 *
 * Every send path in the platform — the agent's tool, the outbound queue, the
 * human-approved reply, booking confirmations, reminders — had the same four
 * steps written out at each call site: claim a slot, hand the message to
 * Mailgun, give the slot back on failure, record the send. Adding a second
 * transport by editing all five would have meant five chances to get the new
 * branch subtly wrong, and a sixth call site written later would simply not
 * know Gmail existed. So the steps live here once and dispatch on the sender.
 *
 * Nothing above this line needs to know which transport it got.
 */

export interface EmailDelivery extends SendResult {
  /** Provider thread id, when the transport threads (Gmail does). */
  threadId?: string;
  /** Real RFC 5322 Message-ID of what was sent, for threading the next reply. */
  headerMessageId?: string;
}

export interface DeliverEmailOptions extends SendEmailOptions {
  /**
   * Conversation this belongs to. Supplies the thread the message must land in
   * — without it a Gmail follow-up opens a new thread in the prospect's inbox,
   * which is the single loudest tell that nobody is really reading the replies.
   */
  conversationId?: string | null;
}

/** Threading material for a conversation: the provider thread and its chain. */
async function threadContext(conversationId: string): Promise<{
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { externalThreadId: true },
  });
  const messages = await prisma.message.findMany({
    where: { conversationId, headerMessageId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { headerMessageId: true },
    // The References header is a chain, not a log. Mail clients thread on the
    // ends of it, and an unbounded one grows a header past what some servers
    // will accept on a long-running conversation.
    take: 20,
  });
  const chain = messages.map((m) => m.headerMessageId!).filter(Boolean);
  return {
    threadId: conversation?.externalThreadId ?? undefined,
    inReplyTo: chain.length ? chain[chain.length - 1] : undefined,
    references: chain.length ? chain : undefined,
  };
}

/**
 * Send, by whichever route this sender represents.
 *
 * The Mailgun branch is exactly what every call site used to do inline. The
 * Gmail branch adds threading, which Mailgun gets for free from the recipient's
 * mail client and Gmail does not.
 */
export async function deliverEmail(
  sender: ResolvedSender,
  opts: DeliverEmailOptions
): Promise<EmailDelivery> {
  if (sender.transport === 'gmail') {
    if (!sender.gmailAccountId) {
      return { sent: false, error: 'No Gmail account on the resolved sender.' };
    }
    const account = await prisma.gmailAccount.findUnique({
      where: { id: sender.gmailAccountId },
    });
    if (!account) return { sent: false, error: 'That Gmail inbox is no longer connected.' };

    const thread = opts.conversationId ? await threadContext(opts.conversationId) : {};
    return sendViaGmail(account, {
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      fromName: opts.fromName,
      replyTo: opts.replyTo,
      html: opts.html,
      unsubscribeUrl: opts.unsubscribeUrl,
      ics: opts.ics,
      ...thread,
    });
  }

  if (!sender.creds) return { sent: false, error: 'No Mailgun credentials on the resolved sender.' };
  const result = await channels.sendEmail(
    {
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      fromName: opts.fromName,
      fromEmail: opts.fromEmail ?? sender.fromEmail,
      replyTo: opts.replyTo,
      html: opts.html,
      unsubscribeUrl: opts.unsubscribeUrl,
      ics: opts.ics,
      trackClicks: opts.trackClicks,
    },
    sender.creds
  );
  // Mailgun's message id IS the RFC 5322 Message-ID, angle brackets and all.
  return {
    ...result,
    headerMessageId: result.externalId
      ? `<${result.externalId.replace(/^<|>$/g, '')}>`
      : undefined,
  };
}

/**
 * Claim this send against whatever ceiling the sender answers to.
 *
 * True when there was nothing to claim — a legacy Mailgun sender, or
 * transactional mail that no cap gates — so callers can treat "reserved" and
 * "no reservation needed" the same way and only handle the refusal.
 */
export async function reserveEmailSend(sender: ResolvedSender): Promise<boolean> {
  if (sender.allowanceToday === undefined) return true;
  if (sender.transport === 'gmail') {
    return sender.gmailAccountId
      ? reserveGmailSend(sender.gmailAccountId, sender.allowanceToday)
      : true;
  }
  return sender.mailboxId ? reserveSend(sender.mailboxId, sender.allowanceToday) : true;
}

/** Give a claimed slot back when the send did not happen. */
export async function releaseEmailSend(sender: ResolvedSender): Promise<void> {
  if (sender.allowanceToday === undefined) return;
  if (sender.transport === 'gmail') {
    if (sender.gmailAccountId) await releaseGmailSend(sender.gmailAccountId);
    return;
  }
  if (sender.mailboxId) await releaseSend(sender.mailboxId);
}

/**
 * Record that this sender just sent. A send that was reserved is already
 * counted; one that wasn't (transactional mail) is counted here, so the day's
 * volume is honest either way.
 */
export async function markEmailSent(
  sender: ResolvedSender,
  at: Date = new Date()
): Promise<void> {
  const countSend = sender.allowanceToday === undefined;
  if (sender.transport === 'gmail') {
    if (sender.gmailAccountId) await markGmailSent(sender.gmailAccountId, at, countSend);
    return;
  }
  if (sender.mailboxId) await markMailboxSent(sender.mailboxId, at, countSend);
}

/**
 * Persist what a delivery taught us about the thread: which sender owns it, the
 * provider's thread id, and the Message-ID of what just went out.
 *
 * The sender fields are written only once — the first send anchors the thread,
 * and later ones must not be able to move it, which is the same rule the
 * Mailgun mailbox stickiness follows.
 */
export async function anchorThread(
  conversationId: string,
  messageId: string | null,
  sender: ResolvedSender,
  delivery: EmailDelivery
): Promise<void> {
  if (sender.transport === 'gmail' && sender.gmailAccountId) {
    await prisma.conversation
      .updateMany({
        where: { id: conversationId, gmailAccountId: null },
        data: { gmailAccountId: sender.gmailAccountId },
      })
      .catch(() => undefined);
  }
  if (delivery.threadId) {
    await prisma.conversation
      .updateMany({
        where: { id: conversationId, externalThreadId: null },
        data: { externalThreadId: delivery.threadId },
      })
      .catch(() => undefined);
  }
  if (messageId && (delivery.headerMessageId || sender.gmailAccountId)) {
    await prisma.message
      .update({
        where: { id: messageId },
        data: {
          ...(delivery.headerMessageId ? { headerMessageId: delivery.headerMessageId } : {}),
          ...(sender.gmailAccountId ? { gmailAccountId: sender.gmailAccountId } : {}),
        },
      })
      .catch(() => undefined);
  }
}
