import { prisma } from '../config/database';
import { resolveSenderIdentity, withSignature } from './identity.service';
import { automationSafetyReason, emailSafetyReason } from './send-safety.service';
import { findUnresolvedPlaceholders } from './placeholder-guard';

export interface EmailStep { id: string; subject: string; body: string; delayDays: number; approved: boolean }
export function stepsFrom(value: unknown): EmailStep[] { return Array.isArray(value) ? value as unknown as EmailStep[] : []; }
export function nextStep(value: unknown, touchCount: number): EmailStep | null {
  const step = stepsFrom(value)[touchCount];
  return step?.approved ? step : null;
}
export function validateStep(value: any): EmailStep {
  const subject = String(value.subject || '').trim();
  const body = String(value.body || '').trim();
  const delayDays = Number(value.delayDays);
  if (!subject || !body || subject.length > 250 || body.length > 20000 || !Number.isInteger(delayDays) || delayDays < 1 || delayDays > 365) throw new Error('Provide a subject, body and whole-number delay of 1–365 days.');
  if (findUnresolvedPlaceholders(subject + '\n' + body).length) throw new Error('Replace placeholders before saving a sequence step.');
  return { id: String(value.id || ''), subject, body, delayDays, approved: value.approved === true };
}

/** Fixed approved copy, persisted once per lead/step. Appending never resets progress. */
export async function runExplicitSequence(campaign: { id: string; organizationId: string; sequenceSteps: unknown; mode: string }): Promise<number> {
  const steps = stepsFrom(campaign.sequenceSteps);
  const firstDraft = steps.findIndex(step => !step.approved);
  const approvedLength = firstDraft < 0 ? steps.length : firstDraft;
  const rows = await prisma.campaignLead.findMany({ where: { campaignId: campaign.id, touchCount: { lt: approvedLength }, status: { in: ['PENDING', 'IN_SEQUENCE'] }, pausedAt: null, lead: { doNotContact: false, coldOutreachHeldAt: null, contactReviewReason: null } }, take: 500, orderBy: { createdAt: 'asc' }, include: { lead: { include: { contacts: true } } } });
  let queued = 0;
  for (const row of rows) {
    const step = nextStep(campaign.sequenceSteps, row.touchCount);
    if (!step) continue; // Wait for an approved step, including at the end of the sequence.
    const dueAt = row.lastTouchAt ? new Date(row.lastTouchAt.getTime() + step.delayDays * 86400000) : new Date();
    if (dueAt > new Date() || (row.nextTouchAt && row.nextTouchAt > new Date())) continue;
    if (await automationSafetyReason(campaign.organizationId, row.leadId, 'EMAIL', campaign.id)) continue;
    let contact = null;
    for (const candidate of row.lead.contacts) {
      if (!await emailSafetyReason(campaign.organizationId, candidate.id)) { contact = candidate; break; }
    }
    if (!contact) continue;
    const identity = await resolveSenderIdentity(campaign.organizationId, { lead: row.lead, channel: 'EMAIL' });
    if (!identity.postalAddress) continue;
    const sequenceKey = `${campaign.id}:${row.leadId}:${step.id}`;
    // Unique sequenceKey prevents concurrent sweeps and future sweeps duplicating this step.
    await prisma.$transaction(async tx => {
      if (await tx.message.findUnique({ where: { sequenceKey } })) return;
      let conversation = await tx.conversation.findFirst({ where: { organizationId: campaign.organizationId, leadId: row.leadId, contactId: contact!.id, channel: 'EMAIL' } });
      if (!conversation) conversation = await tx.conversation.create({ data: { organizationId: campaign.organizationId, leadId: row.leadId, contactId: contact!.id, channel: 'EMAIL', subject: step.subject } });
      await tx.message.create({ data: { conversationId: conversation.id, campaignId: campaign.id, sequenceKey, direction: 'OUTBOUND', subject: step.subject, body: withSignature(step.body, identity), status: campaign.mode === 'APPROVAL_REQUIRED' ? 'draft_pending_approval' : 'scheduled', scheduledAt: campaign.mode === 'APPROVAL_REQUIRED' ? null : dueAt } });
      queued++;
    }).catch((err: any) => { if (err.code !== 'P2002') throw err; });
  }
  return queued;
}
