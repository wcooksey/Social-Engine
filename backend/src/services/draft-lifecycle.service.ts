import { prisma } from '../config/database';

const DRAFT_STATUSES = ['draft', 'draft_blocked', 'draft_pending_approval'];
const SENT_STATUSES = ['sent', 'delivered', 'opened', 'clicked'];

/** Conservative legacy matching: same recipient thread, campaign and exact copy.
 * Never infer equivalence from a subject or company name alone. */
export function isSupersededDraft(
  draft: { id: string; conversationId: string; campaignId: string | null; sequenceKey: string | null; direction: string; status: string | null; subject: string | null; body: string; createdAt: Date; sentAt: Date | null; isConversationReply: boolean },
  sent: { id: string; conversationId: string; campaignId: string | null; sequenceKey: string | null; direction: string; status: string | null; subject: string | null; body: string; sentAt: Date | null },
): boolean {
  return !!draft.campaignId && !draft.isConversationReply && !draft.sentAt &&
    DRAFT_STATUSES.includes(draft.status || '') && draft.direction === 'OUTBOUND' &&
    sent.direction === 'OUTBOUND' && SENT_STATUSES.includes(sent.status || '') &&
    !!sent.sentAt && draft.createdAt <= sent.sentAt && draft.id !== sent.id &&
    draft.conversationId === sent.conversationId && draft.campaignId === sent.campaignId &&
    draft.subject === sent.subject && draft.body === sent.body &&
    // Distinct known steps may intentionally reuse copy. Leave those alone.
    (!draft.sequenceKey || !sent.sequenceKey || draft.sequenceKey === sent.sequenceKey);
}

export async function findSupersededDrafts(organizationId: string, campaignId: string) {
  const drafts = await prisma.message.findMany({
    where: { campaignId, direction: 'OUTBOUND', status: { in: DRAFT_STATUSES }, sentAt: null, isConversationReply: false, conversation: { organizationId, channel: 'EMAIL', contactId: { not: null } } },
    orderBy: { createdAt: 'asc' },
    include: { conversation: { select: { lead: { select: { companyName: true } } } } },
  });
  const matches: { draftId: string; sentMessageId: string; companyName: string; subject: string | null; draftedAt: Date; sentAt: Date }[] = [];
  for (const draft of drafts) {
    const sent = await prisma.message.findMany({ where: {
      conversationId: draft.conversationId, campaignId, direction: 'OUTBOUND',
      status: { in: SENT_STATUSES }, sentAt: { gte: draft.createdAt }, subject: draft.subject, body: draft.body,
    } });
    const match = sent.find(message => isSupersededDraft(draft, message));
    if (match) matches.push({ draftId: draft.id, sentMessageId: match.id, companyName: draft.conversation.lead.companyName, subject: draft.subject, draftedAt: draft.createdAt, sentAt: match.sentAt! });
  }
  return { examined: drafts.length, matches, unresolved: drafts.length - matches.length };
}

/** Re-read both records in a transaction; only an unsent, unchanged draft can be cancelled. */
export async function cancelSupersededDraft(organizationId: string, draftId: string, sentMessageId: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const draft = await tx.message.findFirst({ where: { id: draftId, conversation: { organizationId, channel: 'EMAIL', contactId: { not: null } } }, include: { conversation: true } });
    const sent = await tx.message.findFirst({ where: { id: sentMessageId, conversation: { organizationId } } });
    if (!draft || !sent || !isSupersededDraft(draft, sent)) return false;
    const reason = `Superseded by sent message ${sent.id}; duplicate draft cancelled without sending.`;
    const changed = await tx.message.updateMany({
      where: { id: draft.id, conversationId: draft.conversationId, direction: 'OUTBOUND', isConversationReply: false, status: draft.status, sentAt: null, body: draft.body, subject: draft.subject, campaignId: draft.campaignId, sequenceKey: draft.sequenceKey },
      data: { status: 'cancelled', scheduledAt: null, blockedReason: reason, retryable: false },
    });
    if (!changed.count) return false;
    await tx.activity.create({ data: { organizationId, leadId: draft.conversation.leadId, campaignId: draft.campaignId, type: 'STATUS_CHANGE', summary: reason, payload: { draftId: draft.id, sentMessageId: sent.id } } });
    return true;
  });
}

export async function retireSupersededDrafts(organizationId: string, sentMessageId: string): Promise<number> {
  const sent = await prisma.message.findFirst({ where: { id: sentMessageId, conversation: { organizationId, channel: 'EMAIL', contactId: { not: null } } } });
  if (!sent?.campaignId || !sent.sentAt) return 0;
  const drafts = await prisma.message.findMany({ where: { conversationId: sent.conversationId, campaignId: sent.campaignId, direction: 'OUTBOUND', status: { in: DRAFT_STATUSES }, sentAt: null, createdAt: { lte: sent.sentAt } } });
  let cancelled = 0;
  for (const draft of drafts) {
    if (isSupersededDraft(draft, sent) && await cancelSupersededDraft(organizationId, draft.id, sent.id)) cancelled++;
  }
  return cancelled;
}

/** Used before approval and by the queue; an old draft cannot be revived into a duplicate. */
export async function supersedingMessage(message: { id: string; conversationId: string; campaignId: string | null; sequenceKey: string | null; subject: string | null; body: string; createdAt: Date; isConversationReply: boolean }) {
  if (!message.campaignId || message.isConversationReply) return null;
  const candidates = await prisma.message.findMany({ where: {
    id: { not: message.id }, conversationId: message.conversationId, campaignId: message.campaignId,
    direction: 'OUTBOUND', status: { in: SENT_STATUSES }, sentAt: { gte: message.createdAt },
    subject: message.subject, body: message.body,
  } });
  return candidates.find(sent => isSupersededDraft({ ...message, direction: 'OUTBOUND', status: 'draft_blocked', sentAt: null }, sent)) || null;
}
