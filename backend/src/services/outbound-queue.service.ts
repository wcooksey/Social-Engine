import { retireSupersededDrafts, supersedingMessage } from './draft-lifecycle.service';
import { outboundBlock } from './outbound.service';
import { automationSafetyReason, emailSafetyReason } from './send-safety.service';
import { prisma } from '../config/database';
import {
  identityFromName,
  resolveSenderIdentity,
  withSignature,
} from './identity.service';
import { leadService } from './lead.service';
import {
  deferCampaignTouch,
  recordCampaignTouch,
  unsubscribeUrlFor,
} from './outbound.service';
import { suppressionReason } from './suppression.service';
import { findUnresolvedPlaceholders } from './placeholder-guard';
import { recordSend } from './experiment.service';
import {
  anchorThread,
  deliverEmail,
  markEmailSent,
  releaseEmailSend,
  reserveEmailSend,
} from './email-delivery.service';
import type { ResolvedSender } from './sender.service';
import { resolveSenderDecision } from './sender.service';
import { getOrgConfig } from './settings.service';

/**
 * Outbound send queue.
 *
 * Warm-up pacing means a composed message often cannot go out this minute. The
 * alternative to holding it is throwing it away and re-running the whole agent
 * later, which costs a full LLM run per send and re-writes a message that was
 * already fine. Instead the message is persisted as `scheduled` and this sweep
 * puts it on the wire when its mailbox frees up — no model involved.
 *
 * Everything a queued message deferred is re-checked at send time, because the
 * world moves between composing and sending: the lead may have unsubscribed, the
 * org may have hit its cap or entered quiet hours, the mailbox may have been
 * paused by the circuit breaker.
 */

/** Messages drained per sweep. Bounded so one org can't monopolise a pass. */
const DRAIN_BATCH = 50;

/**
 * How long a claimed message may sit in `sending` before a later pass assumes
 * the worker that claimed it is gone. Comfortably longer than a full batch of
 * 15-second provider timeouts, so a slow pass is never robbed of its own work.
 */
const STALE_CLAIM_MS = 20 * 60 * 1000;

/** A queued message this old is stale — the offer and the thread have moved on. */
const MAX_QUEUE_AGE_MS = 3 * 24 * 3600 * 1000;

/** How far out to push a message that is due but still can't go. */
const RESCHEDULE_MS = 15 * 60 * 1000;

export interface QueueSweepResult {
  sent: number;
  rescheduled: number;
  cancelled: number;
  expired: number;
}

export async function runOutboundQueueSweep(now: Date = new Date()): Promise<QueueSweepResult> {
  const result: QueueSweepResult = { sent: 0, rescheduled: 0, cancelled: 0, expired: 0 };

  // Reclaim anything a previous pass claimed but never finished — a deploy or a
  // crash between the claim and the terminal write would otherwise strand the
  // message in 'sending', where nothing queries it: not the due query below, not
  // the expiry (which lives inside deliver), not the cancel route.
  await prisma.message
    .updateMany({
      where: { status: 'sending', scheduledAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      data: { status: 'scheduled' },
    })
    .catch(() => undefined);

  // Two scans guarantee due follow-ups are considered before fresh introductions.
  const followup = { provenance: { path: ['outreachKind'], equals: 'followup' } };
  const dueFollowups = await prisma.message.findMany({ where: { status: 'scheduled', scheduledAt: { lte: now }, ...followup }, orderBy: { scheduledAt: 'asc' }, take: DRAIN_BATCH, select: { id: true } });
  const remaining = DRAIN_BATCH - dueFollowups.length;
  const other = remaining ? await prisma.message.findMany({ where: { status: 'scheduled', scheduledAt: { lte: now }, id: { notIn: dueFollowups.map(m => m.id) } }, orderBy: { scheduledAt: 'asc' }, take: remaining, select: { id: true } }) : [];
  const due = [...dueFollowups, ...other];
  if (due.length === 0) return result;

  for (const { id } of due) {
    // Claim it before doing any work: a second worker draining the same queue
    // must not send the same message twice.
    const claimed = await prisma.message.updateMany({
      where: { id, status: 'scheduled' },
      data: { status: 'sending' },
    });
    if (claimed.count === 0) continue;

    try {
      const outcome = await deliver(id, now);
      result[outcome]++;
    } catch (err) {
      // Never leave a message stuck in `sending` — it would never be retried.
      // Guarded inside its own try: a failure here must not abort the sweep,
      // which would take every other sweep in the worker tick down with it.
      try {
        await reschedule(id, now, `queue error: ${err instanceof Error ? err.message : 'unknown'}`);
        result.rescheduled++;
      } catch {
        // The reclaim at the top of the next pass will pick it up.
      }
    }
  }
  return result;
}

type Outcome = 'sent' | 'rescheduled' | 'cancelled' | 'expired';

async function deliver(messageId: string, now: Date): Promise<Outcome> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      conversation: {
        include: {
          lead: true,
          contact: true,
        },
      },
    },
  });
  if (!message) return 'cancelled';

  const { conversation } = message;
  const lead = conversation.lead;
  const contact = conversation.contact;
  const organizationId = conversation.organizationId;

  const superseding = await supersedingMessage(message);
  if (superseding) {
    await close(message.id, 'cancelled', organizationId, lead.id, `Superseded by sent message ${superseding.id}; duplicate cancelled without sending.`);
    return 'cancelled';
  }

  if (now.getTime() - message.createdAt.getTime() > MAX_QUEUE_AGE_MS) {
    await close(message.id, 'failed', organizationId, lead.id, `Queued email expired unsent after 3 days.`);
    return 'expired';
  }

  // Compliance is re-checked, not remembered. A lead who unsubscribed while this
  // sat in the queue must not receive it.
  if (lead.doNotContact) {
    await close(message.id, 'cancelled', organizationId, lead.id, `Queued email cancelled — ${lead.companyName} is now do-not-contact.`);
    return 'cancelled';
  }
  if (!contact?.email) {
    await close(message.id, 'cancelled', organizationId, lead.id, 'Queued email cancelled — the contact no longer has an email address.');
    return 'cancelled';
  }
  if (contact.optedOut || contact.emailStatus) {
    await close(message.id, 'cancelled', organizationId, lead.id, `Queued email cancelled — ${contact.email} is ${contact.emailStatus || 'opted out'}.`);
    return 'cancelled';
  }
  // The standing list, re-checked here because a message composed hours ago may
  // be addressed to someone who has opted out since.
  const suppressed = await suppressionReason(organizationId, { email: contact.email });
  if (suppressed) {
    await close(message.id, 'cancelled', organizationId, lead.id, `Queued email cancelled — ${suppressed}`);
    return 'cancelled';
  }
  if (lead.contactReviewReason) {
    await close(message.id, 'cancelled', organizationId, lead.id, `Queued email cancelled — ${lead.companyName} is on hold: ${lead.contactReviewReason}`);
    return 'cancelled';
  }
  // A queued message was composed by an agent that is long gone, so nothing has
  // looked at this text since. Cancel rather than reschedule: a template token
  // will not resolve itself on the next sweep, and retrying forever would just
  // delay the same broken send by fifteen minutes at a time.
  const unfilled = findUnresolvedPlaceholders(`${message.subject ?? ''}\n${message.body}`);
  if (unfilled.length) {
    await close(
      message.id,
      'cancelled',
      organizationId,
      lead.id,
      `Queued email cancelled — it still contained unfilled placeholders (${unfilled.join(', ')}). ` +
        'Ask the Engine to rewrite it.'
    );
    return 'cancelled';
  }

  // The campaign can change its mind while a message waits. Switching to
  // approval-required after composing means a human now wants to see this before
  // it goes; pausing the campaign means it should not go at all yet.
  if (message.campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: message.campaignId },
      select: { mode: true, status: true },
    });
    if (campaign?.mode === 'APPROVAL_REQUIRED' && !message.approvedAt) {
      await prisma.message.updateMany({
        where: { id: message.id, status: 'sending' },
        data: { status: 'draft_pending_approval', scheduledAt: null, blockedReason: 'Campaign requires approval before sending.', retryable: false },
      });
      return 'cancelled';
    }
    if (campaign && campaign.status !== 'ACTIVE') {
      return (await reschedule(message.id, now, `campaign is ${campaign.status}`, undefined, message.campaignId, lead.id)) as Outcome;
    }
  }

  // Org guardrails too: quiet hours in particular, since the whole point of the
  // queue is that time has passed since the message was written.
  const blocked = await outboundBlock(organizationId, lead, now);
  if (blocked) {
    if (!blocked.retryAt) {
      await prisma.message.updateMany({ where: { id: message.id, status: 'sending' }, data: { status: 'draft_blocked', scheduledAt: null, blockedReason: blocked.reason, retryable: false } });
      return 'cancelled';
    }
    return await reschedule(message.id, now, blocked.reason, blocked.retryAt, message.campaignId, lead.id);
  }

  const orgConfig = await getOrgConfig(organizationId);
  const identity = await resolveSenderIdentity(organizationId, {
    lead: { id: lead.id, groupId: lead.groupId, status: lead.status },
    channel: 'EMAIL',
    mailgunDomain: orgConfig.mailgun.domain,
  });

  if (!identity.postalAddress) return await reschedule(message.id, now, 'Sender postal footer is missing.') as Outcome;

  const decision = await resolveSenderDecision(organizationId, {
    purpose: 'COLD_OUTREACH',
    playbookId: identity.routingPlaybookId,
    conversationId: conversation.id,
    preferAddress: identity.email,
    legacy: orgConfig.mailgun,
  });
  const sender = decision.sender;
  if (!sender) {
    return (await reschedule(
      message.id,
      now,
      decision.reason || 'no sender available',
      decision.retryAt,
      message.campaignId,
      lead.id
    )) as Outcome;
  }

  const safety = await automationSafetyReason(organizationId, lead.id, 'EMAIL', message.campaignId, !message.isConversationReply) || await emailSafetyReason(organizationId, contact.id, typeof (message.provenance as any)?.recipientEmail === 'string' ? (message.provenance as any).recipientEmail : contact.email);
  if (safety || (lead.coldOutreachHeldAt && !message.isConversationReply)) {
    await close(message.id, 'cancelled', organizationId, lead.id, safety || 'Queued prospecting cancelled: lead replied.');
    return 'cancelled';
  }
  const reserved = await reserveEmailSend(sender);
  if (!reserved) {
    return (await reschedule(
      message.id,
      now,
      'allowance taken by a concurrent send',
      undefined,
      message.campaignId,
      lead.id
    )) as Outcome;
  }

  const delivery = await deliverEmail(sender, {
    to: contact.email,
    subject: message.subject || conversation.subject || 'Following up',
    // The stored body already carries the signature and postal footer.
    body: message.body,
    // The mailbox that actually carries this wins, because the recipient can
    // check it: mail leaving mike@ must say Mike. The name frozen at compose
    // time is the fallback — it was written before this mailbox was chosen,
    // and warm-up allowance may well have moved the send to a different one.
    fromName: sender.displayName?.trim() || message.senderName || identityFromName(identity),
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo && sender.replyTo !== sender.fromEmail ? sender.replyTo : undefined,
    unsubscribeUrl: unsubscribeUrlFor(contact.id),
    conversationId: conversation.id,
  });

  if (!delivery.sent) {
    await releaseEmailSend(sender);
    return (await reschedule(
      message.id,
      now,
      delivery.error || 'delivery failed',
      undefined,
      message.campaignId,
      lead.id
    )) as Outcome;
  }

  // The mail is on the wire from here. The status write comes first and the rest
  // is best-effort: a bookkeeping failure must not unwind into the sweep's catch,
  // where a reschedule would queue an already-delivered email to be sent again.
  await prisma.message.update({
    where: { id: message.id },
    data: {
      status: 'sent',
      blockedReason: null,
      retryable: false,
      sentAt: now,
      scheduledAt: null,
      externalId: delivery.externalId?.replace(/^<|>$/g, ''),
      mailboxId: sender.mailboxId,
    },
  });
  await retireSupersededDrafts(organizationId, message.id).catch(err => console.error('Failed to retire duplicate drafts:', err instanceof Error ? err.message : err));
  await anchorThread(conversation.id, message.id, sender, delivery).catch(() => undefined);
  await recordDelivery(message, conversation, lead, contact.email, sender, organizationId, now).catch(
    (err) => {
      console.error(
        `Outbound queue: message ${message.id} sent, but bookkeeping failed:`,
        err instanceof Error ? err.message : err
      );
    }
  );
  return 'sent';
}

/** Everything the agent path does after a send, so the two are indistinguishable. */
async function recordDelivery(
  message: { id: string; subject: string | null; body: string; experimentVariantId: string | null; campaignId: string | null },
  conversation: { id: string; subject: string | null },
  lead: { id: string },
  toAddress: string,
  sender: ResolvedSender,
  organizationId: string,
  now: Date
): Promise<void> {
  await markEmailSent(sender, now);
  if (sender.mailboxId) {
    // Anchor the thread's sender if this was its first real send.
    await prisma.conversation.updateMany({
      where: { id: conversation.id, mailboxId: null },
      data: { mailboxId: sender.mailboxId },
    });
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now },
  });

  // The same bookkeeping an agent-driven send does — the lead should not be able
  // to tell which path put the message on the wire.
  if (message.experimentVariantId) await recordSend(message.experimentVariantId);
  if (message.campaignId) await recordCampaignTouch(message.campaignId, lead.id);
  await leadService.advanceStatusOnTouch(lead.id, 'Email');
  await leadService.logActivity({
    organizationId,
    leadId: lead.id,
    type: 'EMAIL_SENT',
    summary: `Email sent to ${toAddress}: "${message.subject || conversation.subject || ''}" (queued for sender pacing)`,
    payload: {
      subject: message.subject,
      body: message.body,
      status: 'sent',
      messageId: message.id,
      viaQueue: true,
    },
    campaignId: message.campaignId ?? undefined,
  });
}

/**
 * Put a claimed message back in the queue with a new due time.
 *
 * Guarded on the message still being in flight. The sweep's catch calls this for
 * any throw out of `deliver`, including one from the bookkeeping that runs AFTER
 * the mail is already on the wire — and an unguarded write there would put a
 * delivered message back in the queue to be sent to the prospect a second time.
 */
async function reschedule(
  messageId: string,
  now: Date,
  reason: string,
  retryAt?: Date,
  campaignId?: string | null,
  leadId?: string
): Promise<'rescheduled'> {
  const at = retryAt && retryAt > now ? retryAt : new Date(now.getTime() + RESCHEDULE_MS);
  const moved = await prisma.message.updateMany({
    where: { id: messageId, status: 'sending' },
    data: { status: 'scheduled', scheduledAt: at, blockedReason: reason, retryable: true },
  });
  // Push the cadence hold out with it. A message that keeps being deferred while
  // its campaign clock runs out would otherwise let the sweep compose a second
  // touch for a lead that already has one waiting.
  if (moved.count > 0 && campaignId && leadId) {
    await deferCampaignTouch(campaignId, leadId, new Date(at.getTime() + 60 * 60 * 1000));
  }
  return 'rescheduled';
}

/** End a queued message that must not be sent, leaving a trace on the timeline. */
async function close(
  messageId: string,
  status: 'cancelled' | 'failed',
  organizationId: string,
  leadId: string,
  summary: string
): Promise<void> {
  const closed = await prisma.message.updateMany({
    where: { id: messageId, status: 'sending' },
    data: { status, scheduledAt: null, blockedReason: summary, retryable: false },
  });
  if (closed.count === 0) return; // already terminal — nothing to record
  await leadService.logActivity({
    organizationId,
    leadId,
    type: 'STATUS_CHANGE',
    summary,
    payload: { queuedMessageId: messageId, outcome: status },
  });
}
