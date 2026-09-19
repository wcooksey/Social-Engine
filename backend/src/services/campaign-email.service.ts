import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { outboundBlock } from './outbound.service';
import { automationSafetyReason, emailSafetyReason } from './send-safety.service';

/** Legacy Engine campaigns use the queue too. Persist a unique touch before any
 * provider call, so pacing or repeated Engine attempts reuse the same message. */
export async function prepareCampaignEmail(input: {
  organizationId: string; campaignId: string; leadId: string; contactId: string;
  subject: string; body: string; senderName: string; runId: string; experimentVariantId?: string; provenance?: Prisma.InputJsonObject;
}) {
  const campaign = await prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: input.organizationId } });
  if (!campaign) return { sent: false, reason: 'Campaign not found.' };
  if (campaign.sequenceEnabled) return { sent: false, reason: 'This campaign uses a fixed sequence. Its scheduler owns the approved step; do not compose another message.' };
  const safety = await automationSafetyReason(input.organizationId, input.leadId, 'EMAIL', input.campaignId) || await emailSafetyReason(input.organizationId, input.contactId);
  if (safety) return { sent: false, reason: safety };
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, organizationId: input.organizationId } });
  if (!lead) return { sent: false, reason: 'Lead not found.' };
  const block = await outboundBlock(input.organizationId, lead);
  const approval = campaign.mode === 'APPROVAL_REQUIRED';
  const status = approval ? 'draft_pending_approval' : block && !block.retryAt ? 'draft_blocked' : 'scheduled';
  const scheduledAt = status === 'scheduled' ? block?.retryAt ?? new Date() : null;
  const reason = approval ? 'Campaign requires approval before sending.' : block?.reason ?? null;
  const enrollment = await prisma.campaignLead.findUnique({ where: { campaignId_leadId: { campaignId: campaign.id, leadId: lead.id } } });
  if (!enrollment) return { sent: false, reason: 'Campaign enrollment not found.' };
  if (enrollment.touchCount >= campaign.maxTouches) return { sent: false, reason: 'This campaign cycle has reached its touch limit.' };
  if (enrollment.lastTouchAt) {
    const nextDue = new Date(enrollment.lastTouchAt.getTime() + campaign.followUpCadenceDays * 86400000);
    if (nextDue > new Date()) return { sent: false, reason: `Previous touch already sent. Next campaign touch is not due until ${nextDue.toISOString()}.` };
  }
  const sequenceKey = `${campaign.id}:${lead.id}:legacy-email-cycle-${enrollment.cycle}-touch-${enrollment.touchCount}`;
  let message;
  try {
    message = await prisma.$transaction(async tx => {
      const existing = await tx.message.findUnique({ where: { sequenceKey } });
      if (existing) return existing;
      let conversation = await tx.conversation.findFirst({ where: { organizationId: input.organizationId, leadId: lead.id, contactId: input.contactId, channel: 'EMAIL' } });
      if (!conversation) conversation = await tx.conversation.create({ data: { organizationId: input.organizationId, leadId: lead.id, contactId: input.contactId, channel: 'EMAIL', subject: input.subject } });
      const created = await tx.message.create({ data: {
        conversationId: conversation.id, campaignId: campaign.id, sequenceKey, experimentVariantId: input.experimentVariantId, direction: 'OUTBOUND',
        subject: input.subject, body: input.body, senderName: input.senderName, status, scheduledAt,
        provenance: input.provenance, blockedReason: reason, retryable: status === 'scheduled',
      } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
      await tx.activity.create({ data: { organizationId: input.organizationId, leadId: lead.id, campaignId: campaign.id, agentRunId: input.runId, type: 'FOLLOW_UP_SCHEDULED', summary: `Campaign email ${status}: ${input.subject}`, payload: { messageId: created.id, reason } } });
      return created;
    });
  } catch (err: any) {
    if (err.code !== 'P2002') throw err;
    message = await prisma.message.findUnique({ where: { sequenceKey } });
    if (!message) throw err;
  }
  return { sent: false, queued: message.status === 'scheduled', drafted: message.status?.startsWith('draft'), messageId: message.id, conversationId: message.conversationId, status: message.status, scheduledFor: message.scheduledAt?.toISOString(), reason: message.blockedReason, note: 'This campaign touch is already persisted. Do not rewrite or resend it.' };
}
