import { Channel } from '@prisma/client';
import { prisma } from '../config/database';
import { leadService } from './lead.service';
import { normalizePhone } from './lead.service';
import { recordResponseForInbound } from './experiment.service';

/**
 * Handle an inbound reply from a lead on any channel. Matches the message to a
 * lead/contact, stores it on the conversation, credits the split-test variant
 * that earned the reply, logs the timeline event, and queues an SDR agent to
 * read the thread and respond — the two-way conversation loop.
 */
export interface InboundMessage {
  organizationId?: string;
  channel: Channel;
  /** How to find the lead: an email, phone, social handle, or explicit ids. */
  fromEmail?: string;
  fromPhone?: string;
  socialHandle?: string;
  leadId?: string;
  contactId?: string;
  subject?: string;
  body: string;
  externalId?: string;
}

async function findContact(input: InboundMessage) {
  if (input.contactId) {
    return prisma.contact.findFirst({
      where: {
        id: input.contactId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      },
      include: { lead: true },
    });
  }
  const orgFilter = input.organizationId ? { organizationId: input.organizationId } : {};
  if (input.fromEmail) {
    const c = await prisma.contact.findFirst({
      where: { email: input.fromEmail.toLowerCase().trim(), ...orgFilter },
      include: { lead: true },
    });
    if (c) return c;
  }
  if (input.fromPhone) {
    const digits = normalizePhone(input.fromPhone);
    if (digits) {
      const candidates = await prisma.contact.findMany({
        where: { phone: { not: null }, ...orgFilter },
        include: { lead: true },
        take: 3000,
      });
      const match = candidates.find((c) => normalizePhone(c.phone) === digits);
      if (match) return match;
    }
  }
  if (input.socialHandle) {
    // Best-effort: match a socials JSON value containing the handle
    const candidates = await prisma.contact.findMany({
      where: { socials: { not: Prisma.JsonNull }, ...orgFilter },
      include: { lead: true },
      take: 3000,
    });
    const needle = input.socialHandle.toLowerCase().replace(/^@/, '');
    const match = candidates.find((c) =>
      JSON.stringify(c.socials || {}).toLowerCase().includes(needle)
    );
    if (match) return match;
  }
  return null;
}

export async function handleInbound(input: InboundMessage): Promise<{
  matched: boolean;
  leadId?: string;
  conversationId?: string;
}> {
  let leadId = input.leadId;
  let contactId = input.contactId;
  let organizationId = input.organizationId;

  if (!leadId) {
    const contact = await findContact(input);
    if (contact) {
      leadId = contact.leadId;
      contactId = contact.id;
      organizationId = contact.organizationId;
    }
  }
  if (!leadId || !organizationId) {
    return { matched: false };
  }

  const conversation =
    (await prisma.conversation.findFirst({
      where: { leadId, channel: input.channel },
    })) ??
    (await prisma.conversation.create({
      data: {
        organizationId,
        leadId,
        contactId,
        channel: input.channel,
        subject: input.subject,
      },
    }));

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      body: input.body,
      status: 'received',
      externalId: input.externalId,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Credit the split-test variant that earned this reply (lead+channel scoped).
  await recordResponseForInbound(leadId, input.channel);

  const activityType =
    input.channel === 'EMAIL'
      ? 'EMAIL_REPLY'
      : input.channel === 'SMS'
        ? 'SMS_REPLY'
        : 'SOCIAL_TOUCH';
  await leadService.logActivity({
    organizationId,
    leadId,
    type: activityType,
    summary: `Inbound ${input.channel.toLowerCase()} reply: ${input.body.slice(0, 200)}`,
    payload: { channel: input.channel, body: input.body },
  });

  // Move the lead forward if it was just contacted.
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead && (lead.status === 'CONTACTED' || lead.status === 'NEW')) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'ENGAGED' } });
  }

  // Queue an SDR to read the thread and reply — the two-way loop.
  await prisma.agentJob.create({
    data: {
      organizationId,
      leadId,
      type: 'FOLLOW_UP',
      role: 'SDR',
      objective: `A lead just replied to us on ${input.channel}. Read their message and the full conversation thread (get_lead_timeline), then reply appropriately per the playbooks — answer questions, handle objections, and book a meeting if they're interested. If they ask to stop, mark them NOT_INTERESTED and do not message again. Their message: "${input.body.slice(0, 800)}"`,
      runAt: new Date(),
    },
  });

  return { matched: true, leadId, conversationId: conversation.id };
}

// Imported lazily to avoid a circular import at module load.
import { Prisma } from '@prisma/client';
