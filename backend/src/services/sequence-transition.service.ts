import { verificationBlock } from './send-safety.service';

/** A historical one-touch campaign can continue only where its sent history is unambiguous. */
export function continuationReason(row: any, messages: any[], hasInbound: boolean): string | null {
  if (!['COMPLETED', 'PENDING', 'IN_SEQUENCE'].includes(row.status) || row.pausedAt) return 'Removed, replied, or held enrollment';
  if (row.lead.doNotContact || row.lead.coldOutreachHeldAt || row.lead.contactReviewReason || !['NEW', 'CONTACTED'].includes(row.lead.status)) return 'Lead is excluded or engaged';
  if (hasInbound) return 'Incoming reply exists';
  if (row.touchCount === 0) return 'Untouched lead needs qualification before fixed outreach';
  if (row.touchCount !== 1 || messages.length !== 1 || messages[0].campaignId !== row.campaignId) return 'Send history needs review';
  if (!messages[0].conversation.contact || verificationBlock(messages[0].conversation.contact)) return 'Previous recipient is not currently sendable';
  return null;
}

export async function transitionPreview(db: any, organizationId: string, campaignId: string) {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign || campaign.sequenceEnabled || campaign.status !== 'PAUSED' || campaign.maxTouches !== 1 || campaign.channels.length !== 1 || campaign.channels[0] !== 'EMAIL') throw new Error('Pause a one-touch email campaign before continuing its history.');
  const rows = await db.campaignLead.findMany({ where: { campaignId }, include: { lead: true } });
  const messages = await db.message.findMany({ where: { conversation: { organizationId, leadId: { in: rows.map((r: any) => r.leadId) } }, OR: [{ direction: 'INBOUND' }, { direction: 'OUTBOUND', sentAt: { not: null } }] }, include: { conversation: { include: { contact: true } } } });
  const suppressions = await db.suppression.findMany({ where: { organizationId, kind: { in: ['EMAIL', 'DOMAIN'] } } });
  const eligible: any[] = []; const excluded: Record<string, number> = {};
  for (const row of rows) {
    const history = messages.filter((m: any) => m.conversation.leadId === row.leadId);
    const sent = history.filter((m: any) => m.direction === 'OUTBOUND');
    let reason = continuationReason(row, sent, history.some((m: any) => m.direction === 'INBOUND'));
    const email = sent[0]?.conversation.contact?.email?.trim().toLowerCase();
    if (!reason && email && suppressions.some((s: any) => s.value === email || (s.kind === 'DOMAIN' && s.value === email.split('@')[1]))) reason = 'Previous recipient is suppressed';
    if (!reason && email && await db.message.findFirst({ where: { direction: 'OUTBOUND', OR: [{ sentAt: { not: null } }, { status: { in: ['scheduled', 'sending', 'draft_pending_approval'] } }], conversation: { organizationId, leadId: { not: row.leadId }, contact: { email: { equals: email, mode: 'insensitive' } } } }, select: { id: true } })) reason = 'Recipient shared with another contacted lead';
    if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
    else eligible.push({ id: row.id, leadId: row.leadId, touchCount: row.touchCount, lastTouchAt: sent[0]?.sentAt || null, companyName: row.lead.companyName });
  }
  return { campaign, eligible, excluded };
}
