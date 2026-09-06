import { prisma } from '../config/database';
import { suppressionReason } from './suppression.service';

export const VERIFICATION_MAX_AGE_DAYS = 30;
export function verificationBlock(contact: { email: string | null; emailStatus: string | null; optedOut: boolean; emailVerifiedAt: Date | null; emailVerifiedAddress: string | null }, now = new Date()): string | null {
  if (!contact.email) return 'No email address.';
  if (contact.optedOut || contact.emailStatus) return `Address suppressed: ${contact.emailStatus || 'opted out'}.`;
  if (!contact.emailVerifiedAt || contact.emailVerifiedAddress?.toLowerCase().trim() !== contact.email.toLowerCase().trim()) return 'Email has no successful verification for this address. Verify it before sending.';
  const age = now.getTime() - contact.emailVerifiedAt.getTime();
  if (age < 0 || age > VERIFICATION_MAX_AGE_DAYS * 86400000) return 'Email verification is stale (maximum age: 30 days). Verify it again.';
  return null;
}

export async function emailSafetyReason(organizationId: string, contactId: string, expectedEmail?: string | null): Promise<string | null> {
  const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId } });
  if (!contact) return 'Contact not found.';
  if (expectedEmail !== undefined && contact.email?.trim().toLowerCase() !== expectedEmail?.trim().toLowerCase()) return 'Contact email changed while preparing this message. Refresh and verify the intended address.';
  return verificationBlock(contact) || await suppressionReason(organizationId, { email: contact.email });
}

export function engagementBlock(lead: { coldOutreachHeldAt: Date | null; engagementChannel: string | null; status: string }, channel: string, campaignId?: string | null): string | null {
  if (!lead.coldOutreachHeldAt && !['ENGAGED', 'INTERESTED', 'CUSTOMER'].includes(lead.status)) return null;
  if (campaignId || lead.engagementChannel !== channel) return `Cold outreach stopped: a conversation is active${lead.engagementChannel ? ' on ' + lead.engagementChannel : ''}. Continue in that conversation; do not switch channels automatically.`;
  return null;
}

export async function automationSafetyReason(organizationId: string, leadId: string, channel: string, campaignId?: string | null, coldOutreach = false): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
  if (!lead) return 'Lead not found.';
  if (lead.doNotContact || lead.contactReviewReason) return 'Lead is opted out or held for review.';
  const engaged = engagementBlock(lead, channel, campaignId || (coldOutreach ? 'queued prospecting' : null));
  if (engaged) return engaged;
  if (!campaignId && !lead.coldOutreachHeldAt) {
    const explicit = await prisma.campaignLead.findFirst({ where: { leadId, campaign: { organizationId, sequenceEnabled: true, status: 'ACTIVE' }, status: { in: ['PENDING', 'IN_SEQUENCE'] } } });
    if (explicit) return 'This lead is managed by an explicit sequence. Use its campaign; do not send ad hoc automated touches.';
  }
  if (campaignId) {
    const enrollment = await prisma.campaignLead.findFirst({ where: { campaignId, leadId, campaign: { organizationId } }, include: { campaign: true } });
    if (!enrollment || enrollment.campaign.status !== 'ACTIVE' || enrollment.pausedAt || !['PENDING', 'IN_SEQUENCE'].includes(enrollment.status)) return 'Campaign or enrollment is inactive, held, or already replied.';
  }
  return null;
}
