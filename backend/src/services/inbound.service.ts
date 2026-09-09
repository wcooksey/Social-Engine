import { buildReplyObjective } from './reply-objective';
import { replyMessageIds } from './email-thread-headers';
import { Channel, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { recordMailboxEvent } from './sender.service';
import { flagSiblingLocations, suppress } from './suppression.service';
import { leadService } from './lead.service';
import { normalizeDomain, normalizePhone } from './lead.service';
import { recordResponseForInbound } from './experiment.service';
import { recomputeLeadEnrichment } from './lead-enrichment.service';
import { notify } from './notification.service';

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
  inReplyTo?: string;
  references?: string;
  /** Recipient info — used to resolve the owning org so contact matching
   *  never crosses tenants (Mailgun recipient domain / Twilio To number). */
  toEmailDomain?: string;
  toPhone?: string;
}

/**
 * Resolve which org owns the receiving address.
 *
 * Registered sending domains are checked first — an org sends from several, and
 * a reply to any of them belongs to it. The MAILGUN_DOMAIN setting is still
 * consulted afterwards for orgs that have not adopted the domain tables yet;
 * without that fallback every existing deployment would stop threading replies.
 */
async function resolveOrgFromRecipient(input: InboundMessage): Promise<string | undefined> {
  if (input.toEmailDomain) {
    const domain = input.toEmailDomain.toLowerCase().trim();
    // Only a provider-verified domain may claim inbound mail. Registration alone
    // proves nothing about ownership, so an unverified row must not be able to
    // displace another tenant's existing MAILGUN_DOMAIN mapping and take over
    // its replies.
    const registered = await prisma.emailDomain.findFirst({
      where: { domain, status: { not: 'PENDING' } },
      select: { organizationId: true },
    });
    if (registered) return registered.organizationId;
    const row = await prisma.orgSetting.findFirst({
      where: { key: 'MAILGUN_DOMAIN', value: domain },
    });
    if (row) return row.organizationId;
  }
  if (input.toPhone) {
    const digits = normalizePhone(input.toPhone);
    if (digits) {
      const rows = await prisma.orgSetting.findMany({ where: { key: 'TWILIO_FROM_NUMBER' } });
      const match = rows.find((r) => normalizePhone(r.value) === digits);
      if (match) return match.organizationId;
    }
  }
  return undefined;
}

/**
 * Auto-responders, which are not replies.
 *
 * Any inbound message used to retire a lead's campaign rows permanently, so an
 * out-of-office bounce-back ended the sequence as decisively as a real "no
 * thanks" — and because REPLIED is terminal, nothing ever picked that lead up
 * again. A holiday auto-reply cost the lead outright.
 *
 * Pattern matching catches the overwhelming majority and costs nothing. It is
 * deliberately conservative: a false positive here keeps drip-mailing someone
 * who answered, so every pattern below is one a human would never open with.
 */
const AUTO_REPLY_RE = new RegExp(
  [
    'out\\s+of\\s+(the\\s+)?office',
    'auto(matic)?[- ]?repl(y|ies)',
    'automatic response',
    'away from (my|the) (desk|office)',
    'on (annual |parental |sick )?leave until',
    'currently (away|unavailable|on holiday|on vacation)',
    'thank you for (your )?(email|message)[^.]{0,40}(will respond|will get back|has been received)',
    'this (is|was) an automated',
    'do[- ]not[- ]reply',
    'undeliverable',
    'delivery status notification',
    'mail delivery (failed|subsystem)',
    'ticket #?\\d+ (has been )?(created|opened)',
  ].join('|'),
  'i'
);

/** True when this looks machine-generated rather than written by a person. */
export function looksAutomated(subject: string | undefined, body: string): boolean {
  const head = `${subject || ''}\n${body.slice(0, 600)}`;
  return AUTO_REPLY_RE.test(head);
}

/** A return date mentioned by an auto-responder, when it states one. */
function parseReturnDate(text: string, now: Date): Date | null {
  const match = text.match(
    /(?:back|return(?:ing)?|until|through)\s+(?:on\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i
  );
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = match[3]
    ? parseInt(match[3].length === 2 ? `20${match[3]}` : match[3], 10)
    : now.getUTCFullYear();
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  // Only trust a date in the near future; anything else is a misparse.
  const days = (parsed.getTime() - now.getTime()) / 86_400_000;
  return days > 0 && days < 120 ? parsed : null;
}

// Deterministic opt-out: standard SMS STOP keywords + unsubscribe phrasing.
// Never left to the AI — a match hard-flags the lead before any agent runs.
const OPT_OUT_RE =
  /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|remove me|revoke)\s*[.!]*\s*$/i;

/** Free/shared mailbox providers — a sender domain here identifies nobody. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

/**
 * Last-resort match: tie a reply to a lead by the sender's email DOMAIN.
 *
 * Contact-form enquiries are answered by whoever picks up the shared inbox, and
 * colleagues get cc'd into threads — so replies routinely arrive from an
 * address we have never recorded. Without this they'd be dropped as unmatched.
 * Free mail providers are excluded: a gmail.com sender says nothing about which
 * company they belong to and would collide across every lead.
 */
async function findLeadByEmailDomain(
  fromEmail: string | undefined,
  organizationId: string | undefined
): Promise<{ id: string; organizationId: string } | null> {
  if (!fromEmail) return null;
  const domain = normalizeDomain(fromEmail.split('@')[1]);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  return prisma.lead.findFirst({
    where: { domain, ...(organizationId ? { organizationId } : {}) },
    select: { id: true, organizationId: true },
  });
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
  /** Why nothing was recorded, when matched is false — surfaced to the caller
   *  so a dropped reply shows up in the provider's webhook log. */
  reason?: string;
}> {
  let leadId = input.leadId;
  let contactId = input.contactId;
  // Resolve the owning org from the recipient address when the caller didn't
  // supply one, so contact matching below stays inside a single tenant.
  let organizationId = input.organizationId ?? (await resolveOrgFromRecipient(input));
  // A sender address can appear on multiple leads. Resolve the original email
  // before contact matching, confined to the organization owning the recipient.
  let matchedThread: Awaited<ReturnType<typeof prisma.conversation.findFirst>> = null;
  if (input.channel === 'EMAIL' && organizationId) {
    for (const id of replyMessageIds(input.inReplyTo, input.references)) {
      const parent = await prisma.message.findFirst({
        where: {
          direction: 'OUTBOUND',
          conversation: { organizationId, channel: 'EMAIL', ...(leadId ? { leadId } : {}) },
          OR: [{ externalId: { in: [id, `<${id}>`] } }, { headerMessageId: { in: [id, `<${id}>`] } }],
        },
        include: { conversation: true },
      });
      if (parent) { matchedThread = parent.conversation; break; }
    }
    if (matchedThread) {
      leadId = matchedThread.leadId;
      contactId = matchedThread.contactId ?? undefined;
    }
  }

  // Explicit leadId (social bridges) must be proven to belong to the claimed
  // org — otherwise a forged body could attach messages to another tenant.
  if (leadId) {
    if (!organizationId) {
      return { matched: false, reason: 'An explicit leadId needs an organizationId alongside it.' };
    }
    const owned = await prisma.lead.findFirst({
      where: { id: leadId, organizationId },
      select: { id: true },
    });
    if (!owned) {
      return { matched: false, reason: 'That leadId does not belong to that organization.' };
    }
  }

  if (!leadId) {
    if (input.channel === 'EMAIL' && input.fromEmail) {
      const candidates = await prisma.contact.findMany({
        where: { email: input.fromEmail.toLowerCase().trim(), ...(organizationId ? { organizationId } : {}) },
        select: { leadId: true },
      });
      if (new Set(candidates.map(c => c.leadId)).size > 1) {
        return { matched: false, reason: 'Ambiguous sender: multiple leads share this address and no original email thread matched.' };
      }
    }
    const contact = await findContact({ ...input, organizationId });
    if (contact) {
      leadId = contact.leadId;
      contactId = contact.id;
      organizationId = contact.organizationId;
    } else {
      // Nobody we know sent this — fall back to the sender's company domain so
      // replies from unrecorded colleagues (and contact-form enquiries) still
      // land on the right lead. No contact is attached; the thread is enough.
      const lead = await findLeadByEmailDomain(input.fromEmail, organizationId);
      if (lead) {
        leadId = lead.id;
        organizationId = lead.organizationId;
      }
    }
  }
  if (!leadId || !organizationId) {
    const sender = input.fromEmail || input.fromPhone || input.socialHandle || 'unknown sender';
    return {
      matched: false,
      reason: `No contact or lead matches ${sender}${
        organizationId ? '' : ' (and the receiving address matched no organization)'
      }.`,
    };
  }

  const conversation =
    matchedThread ??
    (await prisma.conversation.findFirst({
      where: { organizationId, leadId, channel: input.channel, ...(contactId ? { contactId } : {}) },
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

  // Idempotency: sources that re-deliver (webhook retries, the social inbox
  // sweep re-reading a thread) pass a stable externalId — ingest it once.
  if (input.externalId) {
    const duplicate = await prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        direction: 'INBOUND',
        externalId: input.externalId,
      },
      select: { id: true },
    });
    if (duplicate) {
      return { matched: true, leadId, conversationId: conversation.id };
    }
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      body: input.body,
      status: 'received',
      externalId: input.externalId,
      headerMessageId: input.channel === 'EMAIL' ? input.externalId : undefined,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Credit the split-test variant that earned this reply (lead+channel scoped).
  await recordResponseForInbound(leadId, input.channel);

  // Credit the mailbox too: reply rate is the signal that separates "this
  // sender is trusted" from "this sender is merely not bouncing yet".
  if (conversation.mailboxId) await recordMailboxEvent(conversation.mailboxId, 'replied');

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

  // Deterministic opt-out: STOP/unsubscribe hard-flags the lead and ends the
  // loop here — no agent is queued and the send tools refuse this lead forever.
  if (OPT_OUT_RE.test(input.body)) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { doNotContact: true, status: 'NOT_INTERESTED' },
    });
    if (contactId) {
      await prisma.contact.update({ where: { id: contactId }, data: { optedOut: true } });
      // An opted-out contact is no longer a usable channel — re-grade the lead.
      await recomputeLeadEnrichment(leadId);
    }
    // Durable across both channels: someone who texts STOP has opted out of
    // email too, and vice versa.
    if (input.fromEmail) {
      await suppress({
        organizationId, kind: 'EMAIL', value: input.fromEmail,
        reason: `Replied "${input.body.trim().slice(0, 40)}"`,
        source: 'reply_optout', originLeadId: leadId,
      });
    }
    if (input.fromPhone) {
      await suppress({
        organizationId, kind: 'PHONE', value: input.fromPhone,
        reason: `Replied "${input.body.trim().slice(0, 40)}"`,
        source: 'sms_stop', originLeadId: leadId,
      });
    }
    await flagSiblingLocations(organizationId, leadId, 'asked us to stop').catch(() => 0);
    await leadService.logActivity({
      organizationId,
      leadId,
      type: 'STATUS_CHANGE',
      summary: `Opt-out received on ${input.channel} ("${input.body.trim().slice(0, 40)}") — lead marked do-not-contact.`,
      payload: { channel: input.channel, optOut: true },
    });
    return { matched: true, leadId, conversationId: conversation.id };
  }

  // An auto-responder is not an answer. Log it, hold the cadence until they are
  // back, and leave the lead exactly where it was — no ENGAGED, no terminal
  // REPLIED, no SDR run composing a reply to a robot.
  if (looksAutomated(input.subject, input.body)) {
    const now = new Date();
    const resumeAt = parseReturnDate(input.body, now) ?? new Date(now.getTime() + 7 * 86_400_000);
    await prisma.campaignLead.updateMany({
      where: {
        leadId,
        status: { in: ['PENDING', 'IN_SEQUENCE'] },
        OR: [{ nextTouchAt: null }, { nextTouchAt: { lt: resumeAt } }],
      },
      data: { nextTouchAt: resumeAt },
    });
    await leadService.logActivity({
      organizationId,
      leadId,
      type: 'EMAIL_REPLY',
      summary: `Automated reply received — sequence held until ${resumeAt.toISOString().slice(0, 10)}, lead not counted as engaged.`,
      payload: { channel: input.channel, automated: true, resumeAt: resumeAt.toISOString() },
    });
    return { matched: true, leadId, conversationId: conversation.id };
  }

  // A human reply owns the conversation across all campaigns and channels.
  await prisma.lead.update({ where: { id: leadId }, data: { coldOutreachHeldAt: new Date(), engagementChannel: input.channel } });
  await prisma.message.updateMany({ where: { conversation: { leadId, organizationId }, direction: 'OUTBOUND', status: { in: ['scheduled', 'draft_pending_approval', 'draft_blocked', 'draft'] } }, data: { status: 'cancelled', scheduledAt: null } });

  // Move the lead forward if it was just contacted.
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead && (lead.status === 'CONTACTED' || lead.status === 'NEW')) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'ENGAGED' } });
  }

  // A reply pauses the mechanical cadence on every campaign this lead is in —
  // the SDR conversation loop takes over from the drip.
  await prisma.campaignLead.updateMany({
    where: { leadId, status: { in: ['PENDING', 'IN_SEQUENCE'] } },
    data: { status: 'REPLIED' },
  });

  // Alert the humans that a lead replied (hot signal worth a look).
  const replyLead = lead ?? (await prisma.lead.findUnique({ where: { id: leadId } }));
  await notify({
    organizationId,
    type: 'HOT_REPLY',
    title: `New reply from ${replyLead?.companyName || 'a lead'}`,
    body: `${input.channel} reply: "${input.body.slice(0, 140)}"`,
    leadId,
    emailAlert: true,
  });

  // Queue an SDR to read the thread and reply — the two-way loop. The lead's
  // text is quoted as delimited data so it can't masquerade as instructions.
  await prisma.agentJob.create({
    data: {
      organizationId,
      leadId,
      type: 'FOLLOW_UP',
      role: 'SDR',
      objective: buildReplyObjective(input.channel, input.body) + (input.channel === 'EMAIL'
        ? `\nReply using send_email with conversationId ${conversation.id}${contactId ? ` and contactId ${contactId}` : ''}. Preserve this exact email thread and its sending mailbox.` : ''),
      runAt: new Date(),
    },
  });

  return { matched: true, leadId, conversationId: conversation.id };
}
