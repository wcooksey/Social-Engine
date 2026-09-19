import { prisma } from '../config/database';
import { verificationBlock } from './send-safety.service';

const DRAFT_STATUSES = ['draft', 'draft_blocked', 'draft_pending_approval'];
const SENT_STATUSES = ['sent', 'delivered', 'opened', 'clicked'];

/** Read-only review. Passing these checks is not approval or a delivery promise. */
export function draftReviewReasons(input: {
  createdAt: Date; sequenceKey: string | null; campaignStatus: string; sequenceEnabled: boolean;
  enrollment: { status: string; pausedAt: Date | null } | null;
  lead: { status: string; doNotContact: boolean; contactReviewReason: string | null; coldOutreachHeldAt: Date | null };
  contact: Parameters<typeof verificationBlock>[0] | null;
  sentCount: number; hasInbound: boolean; hasOtherPending: boolean; sharedRecipient: boolean; suppressed: boolean;
}, now = new Date()): string[] {
  const reasons: string[] = [];
  if (input.campaignStatus !== 'ACTIVE') reasons.push('Campaign is not active');
  if (!input.enrollment || !['PENDING', 'IN_SEQUENCE'].includes(input.enrollment.status) || input.enrollment.pausedAt) reasons.push('Enrollment removed, completed, replied, or held');
  if (input.lead.doNotContact || input.lead.contactReviewReason || input.lead.coldOutreachHeldAt || !['NEW', 'CONTACTED'].includes(input.lead.status)) reasons.push('Lead excluded, held, or engaged');
  const verification = input.contact ? verificationBlock(input.contact, now) : 'No recipient contact';
  if (verification) reasons.push(verification);
  if (input.suppressed) reasons.push('Recipient or domain is suppressed');
  if (input.hasInbound) reasons.push('Incoming message requires conversation review');
  if (input.sentCount) reasons.push('Prior outbound history requires step review');
  if (input.hasOtherPending) reasons.push('Another draft or queued message exists for this lead');
  if (input.sharedRecipient) reasons.push('Recipient address is shared with another lead');
  if (now.getTime() - input.createdAt.getTime() > 3 * 86400000) reasons.push('Draft exceeds the three-day queue lifetime');
  if (input.sequenceEnabled && !input.sequenceKey) reasons.push('Legacy draft is not bound to a fixed sequence step');
  return reasons;
}

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
    include: { conversation: { include: { lead: true, contact: true } } },
  });
  const leadIds = [...new Set(drafts.map(d => d.conversation.leadId))];
  const [campaign, enrollments, history, suppressions, recipientContacts] = await Promise.all([
    prisma.campaign.findFirstOrThrow({ where: { id: campaignId, organizationId }, select: { status: true, sequenceEnabled: true } }),
    prisma.campaignLead.findMany({ where: { campaignId, leadId: { in: leadIds } } }),
    prisma.message.findMany({ where: { conversation: { organizationId, leadId: { in: leadIds } } }, include: { conversation: { select: { leadId: true } } } }),
    prisma.suppression.findMany({ where: { organizationId, kind: { in: ['EMAIL', 'DOMAIN'] } }, select: { kind: true, value: true } }),
    prisma.contact.findMany({ where: { organizationId, email: { not: null } }, select: { leadId: true, email: true } }),
  ]);
  const matches: { draftId: string; sentMessageId: string; companyName: string; subject: string | null; draftedAt: Date; sentAt: Date }[] = [];
  for (const draft of drafts) {
    const match = history.find(message => isSupersededDraft(draft, message));
    if (match) matches.push({ draftId: draft.id, sentMessageId: match.id, companyName: draft.conversation.lead.companyName, subject: draft.subject, draftedAt: draft.createdAt, sentAt: match.sentAt! });
  }
  const matched = new Set(matches.map(m => m.draftId));
  const review = drafts.filter(d => !matched.has(d.id)).map(draft => {
    const conversation = draft.conversation;
    const email = conversation.contact?.email?.trim().toLowerCase();
    const leadHistory = history.filter(m => m.conversation.leadId === conversation.leadId);
    const reasons = draftReviewReasons({
      createdAt: draft.createdAt, sequenceKey: draft.sequenceKey, campaignStatus: campaign.status, sequenceEnabled: campaign.sequenceEnabled,
      enrollment: enrollments.find(e => e.leadId === conversation.leadId) || null,
      lead: conversation.lead, contact: conversation.contact,
      sentCount: leadHistory.filter(m => m.direction === 'OUTBOUND' && m.sentAt).length,
      hasInbound: leadHistory.some(m => m.direction === 'INBOUND'),
      hasOtherPending: leadHistory.some(m => m.id !== draft.id && m.direction === 'OUTBOUND' && ['scheduled', 'sending', ...DRAFT_STATUSES].includes(m.status || '')),
      sharedRecipient: !!email && recipientContacts.some(c => c.leadId !== conversation.leadId && c.email?.trim().toLowerCase() === email),
      suppressed: !!email && suppressions.some(s => s.value.toLowerCase() === (s.kind === 'DOMAIN' ? email.split('@')[1] : email)),
    });
    return { draftId: draft.id, leadId: conversation.leadId, companyName: conversation.lead.companyName, subject: draft.subject, draftedAt: draft.createdAt, reasons };
  });
  const reviewCounts: Record<string, number> = {};
  for (const row of review) for (const reason of row.reasons) reviewCounts[reason] = (reviewCounts[reason] || 0) + 1;
  return { examined: drafts.length, matches, unresolved: review.length, review, reviewCounts };
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
