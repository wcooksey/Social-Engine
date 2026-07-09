import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { leadService } from '../services/lead.service';
import { researchService } from './research.service';

export interface ToolContext {
  organizationId: string;
  runId: string;
}

type ToolInput = Record<string, any>;
type ToolExecutor = (input: ToolInput, ctx: ToolContext) => Promise<unknown>;

/**
 * The Engine's control surface. Every mutation the AI makes goes through one
 * of these executors: validated, org-scoped, deduplicated, and audit-logged
 * via AgentStep. The AI never touches the database directly.
 */
export const engineTools: Anthropic.Tool[] = [
  {
    name: 'search_web',
    description:
      'Search the internet for businesses, people, or pages. Returns titles, URLs, and descriptions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description:
      'Fetch a web page and return its readable text content. Use to research a business website, find contact/about pages, emails, phone numbers, and social links.',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
    },
  },
  {
    name: 'create_lead_group',
    description: 'Create a named group/segment of leads (e.g. "Florida Dealerships"). Idempotent by name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        goal: { type: 'string', description: 'What we are trying to accomplish with this group' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_leads',
    description:
      'Search existing leads in the CRM. ALWAYS use this to check for duplicates before creating leads, and to build target lists for outreach.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Free text: company name, domain, or city' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        groupName: { type: 'string' },
        state: { type: 'string', description: 'Two-letter state/region filter' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      },
    },
  },
  {
    name: 'upsert_lead',
    description:
      'Create or update a lead (a business/prospect). Deduplicates automatically by website domain, company name + location, and phone. Returns the lead and whether it was created or merged.',
    input_schema: {
      type: 'object' as const,
      properties: {
        companyName: { type: 'string' },
        website: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
        industry: { type: 'string' },
        groupName: { type: 'string', description: 'Group to place the lead in (created if missing)' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        aiSummary: { type: 'string', description: 'Your research notes about this lead' },
        socials: {
          type: 'object',
          description: 'Social profile URLs, e.g. {"linkedin": "...", "facebook": "..."}',
        },
      },
      required: ['companyName'],
    },
  },
  {
    name: 'upsert_contact',
    description:
      'Add or update a person at a lead (decision maker, manager). Deduplicates by email within the lead. Only record contact details you actually found.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        title: { type: 'string', description: 'Job title, e.g. "General Manager"' },
        email: { type: 'string' },
        phone: { type: 'string' },
        socials: { type: 'object' },
        isPrimary: { type: 'boolean' },
      },
      required: ['leadId', 'firstName'],
    },
  },
  {
    name: 'get_lead_timeline',
    description:
      'Get a lead with its contacts and recent activity timeline. ALWAYS read this before messaging a lead so outreach reflects history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        limit: { type: 'number', description: 'Max activities (default 20)' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a research note or observation to a lead timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['leadId', 'note'],
    },
  },
  {
    name: 'update_lead_status',
    description: 'Move a lead through the pipeline (e.g. to INTERESTED after a positive reply).',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        reason: { type: 'string' },
      },
      required: ['leadId', 'status'],
    },
  },
  {
    name: 'create_campaign',
    description: 'Create an outreach campaign with an offer and channel mix.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        offer: { type: 'string', description: 'The pitch/offer to work from' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['EMAIL', 'SMS', 'VOICE', 'SOCIAL'] },
        },
        mode: {
          type: 'string',
          enum: ['AUTONOMOUS', 'APPROVAL_REQUIRED'],
          description: 'AUTONOMOUS sends without human approval; default APPROVAL_REQUIRED',
        },
        followUpCadenceDays: { type: 'number' },
        maxTouches: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_leads_to_campaign',
    description: 'Enroll leads into a campaign (skips leads already enrolled).',
    input_schema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string' },
        leadIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['campaignId', 'leadIds'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send (or draft, in approval mode / when the channel is unconfigured) an email to a lead contact. Records the message on the lead conversation and timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string', description: 'Target contact; defaults to primary contact' },
        subject: { type: 'string' },
        body: { type: 'string' },
        campaignId: { type: 'string' },
      },
      required: ['leadId', 'subject', 'body'],
    },
  },
  {
    name: 'send_sms',
    description:
      'Send (or draft) an SMS to a lead contact. Records the message on the lead conversation and timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string' },
        body: { type: 'string' },
        campaignId: { type: 'string' },
      },
      required: ['leadId', 'body'],
    },
  },
  {
    name: 'place_call',
    description:
      'Queue an AI voice call to a lead contact with a call objective. (Voice channel is phase 2 — currently records the intent as a pending activity.)',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string' },
        objective: { type: 'string', description: 'What the call should accomplish' },
        campaignId: { type: 'string' },
      },
      required: ['leadId', 'objective'],
    },
  },
  {
    name: 'schedule_followup',
    description:
      'Schedule your own future work: a follow-up on a lead, the next campaign step, or a research continuation. The Engine wakes up at runAt and executes the objective. This is how you stay persistent across days/weeks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        objective: { type: 'string', description: 'Instruction to your future self, with all needed context' },
        type: { type: 'string', enum: ['FOLLOW_UP', 'RESEARCH', 'CAMPAIGN_STEP', 'CUSTOM'] },
        leadId: { type: 'string' },
        campaignId: { type: 'string' },
        delayHours: { type: 'number', description: 'Hours from now (alternative to runAtIso)' },
        runAtIso: { type: 'string', description: 'Absolute ISO-8601 time' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'update_group_summary',
    description:
      'Update the rolling AI summary on a lead group — your long-term memory of progress, findings, and next steps for that group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string' },
        aiSummary: { type: 'string' },
      },
      required: ['groupName', 'aiSummary'],
    },
  },
];

async function requireLead(leadId: string, organizationId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
  if (!lead) throw new Error(`Lead ${leadId} not found in this organization`);
  return lead;
}

/**
 * Outbound guardrails: org kill switch, quiet hours, daily send cap.
 * Returns a reason string when sending is blocked, else null.
 */
async function outboundBlockReason(organizationId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) return 'Organization not found';
  if (org.paused) return 'Organization is paused (kill switch) — no outbound allowed. Save drafts instead.';

  const hour = new Date().getHours();
  const { quietHoursStart: start, quietHoursEnd: end } = org;
  const inQuietHours = start > end ? hour >= start || hour < end : hour >= start && hour < end;
  if (inQuietHours) return `Inside quiet hours (${start}:00–${end}:00) — schedule the send for later instead.`;

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const sentToday = await prisma.activity.count({
    where: {
      organizationId,
      type: { in: ['EMAIL_SENT', 'SMS_SENT', 'CALL_PLACED'] },
      createdAt: { gte: since },
    },
  });
  if (sentToday >= org.dailySendCap) return `Daily send cap reached (${org.dailySendCap}). Schedule remaining sends for tomorrow.`;
  return null;
}

async function recordOutbound(opts: {
  ctx: ToolContext;
  leadId: string;
  contactId?: string;
  channel: 'EMAIL' | 'SMS';
  subject?: string;
  body: string;
  campaignId?: string;
  status: string;
  activityType: 'EMAIL_SENT' | 'SMS_SENT';
  activitySummary: string;
}) {
  const conversation =
    (await prisma.conversation.findFirst({
      where: { leadId: opts.leadId, channel: opts.channel, contactId: opts.contactId ?? undefined },
    })) ??
    (await prisma.conversation.create({
      data: {
        organizationId: opts.ctx.organizationId,
        leadId: opts.leadId,
        contactId: opts.contactId,
        channel: opts.channel,
        subject: opts.subject,
      },
    }));

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      body: opts.body,
      status: opts.status,
      sentAt: opts.status === 'sent' ? new Date() : null,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });
  await leadService.logActivity({
    organizationId: opts.ctx.organizationId,
    leadId: opts.leadId,
    type: opts.activityType,
    summary: opts.activitySummary,
    payload: { subject: opts.subject, body: opts.body, status: opts.status, messageId: message.id },
    campaignId: opts.campaignId,
    agentRunId: opts.ctx.runId,
  });
  return { conversationId: conversation.id, messageId: message.id, status: opts.status };
}

const executors: Record<string, ToolExecutor> = {
  search_web: (input) => researchService.searchWeb(input.query, input.count),

  fetch_page: (input) => researchService.fetchPage(input.url),

  create_lead_group: async (input, ctx) => {
    const group = await prisma.leadGroup.upsert({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: input.name.trim() } },
      create: { organizationId: ctx.organizationId, name: input.name.trim(), goal: input.goal },
      update: { ...(input.goal ? { goal: input.goal } : {}) },
    });
    return { id: group.id, name: group.name, goal: group.goal };
  },

  search_leads: async (input, ctx) => {
    let groupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: input.groupName } },
      });
      if (!group) return { leads: [], total: 0, note: `No group named "${input.groupName}"` };
      groupId = group.id;
    }
    const result = await leadService.searchLeads(ctx.organizationId, {
      search: input.search,
      status: input.status,
      groupId,
      state: input.state,
      pageSize: Math.min(input.limit || 25, 100),
    });
    return {
      total: result.total,
      leads: result.leads.map((l) => ({
        id: l.id,
        companyName: l.companyName,
        domain: l.domain,
        city: l.city,
        state: l.state,
        status: l.status,
        group: l.group?.name,
        contactCount: l.contactCount,
      })),
    };
  },

  upsert_lead: async (input, ctx) => {
    const { lead, created } = await leadService.upsertLead(ctx.organizationId, {
      ...(input as import('../services/lead.service').UpsertLeadInput),
      source: 'web_research',
    });
    if (created) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: lead.id,
        type: 'RESEARCH',
        summary: `Lead created by the Engine${input.groupName ? ` in group "${input.groupName}"` : ''}`,
        agentRunId: ctx.runId,
      });
    }
    return { leadId: lead.id, companyName: lead.companyName, created, mergedIntoExisting: !created };
  },

  upsert_contact: async (input, ctx) => {
    await requireLead(input.leadId, ctx.organizationId);
    const email = input.email?.toLowerCase().trim() || null;
    const data = {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      email,
      phone: input.phone ?? null,
      socials: input.socials ? (input.socials as Prisma.InputJsonValue) : undefined,
      isPrimary: !!input.isPrimary,
      source: 'web_research',
    };
    const existing = email
      ? await prisma.contact.findUnique({ where: { leadId_email: { leadId: input.leadId, email } } })
      : await prisma.contact.findFirst({
          where: {
            leadId: input.leadId,
            firstName: { equals: input.firstName, mode: 'insensitive' },
            lastName: { equals: input.lastName ?? '', mode: 'insensitive' },
          },
        });
    const contact = existing
      ? await prisma.contact.update({ where: { id: existing.id }, data })
      : await prisma.contact.create({
          data: { ...data, leadId: input.leadId, organizationId: ctx.organizationId },
        });
    return { contactId: contact.id, created: !existing };
  },

  get_lead_timeline: async (input, ctx) => {
    const lead = await prisma.lead.findFirst({
      where: { id: input.leadId, organizationId: ctx.organizationId },
      include: {
        group: { select: { name: true } },
        contacts: true,
        activities: { orderBy: { createdAt: 'desc' }, take: Math.min(input.limit || 20, 50) },
      },
    });
    if (!lead) throw new Error(`Lead ${input.leadId} not found`);
    return {
      id: lead.id,
      companyName: lead.companyName,
      status: lead.status,
      group: lead.group?.name,
      aiSummary: lead.aiSummary,
      contacts: lead.contacts.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName || ''}`.trim(),
        title: c.title,
        email: c.email,
        phone: c.phone,
        isPrimary: c.isPrimary,
        optedOut: c.optedOut,
      })),
      timeline: lead.activities.map((a) => ({
        type: a.type,
        summary: a.summary,
        at: a.createdAt.toISOString(),
      })),
    };
  },

  add_note: async (input, ctx) => {
    await requireLead(input.leadId, ctx.organizationId);
    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: input.leadId,
      type: 'NOTE',
      summary: input.note,
      agentRunId: ctx.runId,
    });
    return { ok: true };
  },

  update_lead_status: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: input.status } });
    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'STATUS_CHANGE',
      summary: `Status changed from ${lead.status} to ${input.status}${input.reason ? ` — ${input.reason}` : ''}`,
      agentRunId: ctx.runId,
    });
    return { ok: true, previousStatus: lead.status, status: input.status };
  },

  create_campaign: async (input, ctx) => {
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        offer: input.offer,
        channels: input.channels || ['EMAIL'],
        mode: input.mode || 'APPROVAL_REQUIRED',
        followUpCadenceDays: input.followUpCadenceDays ?? 3,
        maxTouches: input.maxTouches ?? 6,
      },
    });
    return { campaignId: campaign.id, name: campaign.name, mode: campaign.mode };
  },

  add_leads_to_campaign: async (input, ctx) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: input.campaignId, organizationId: ctx.organizationId },
    });
    if (!campaign) throw new Error('Campaign not found');
    const leads = await prisma.lead.findMany({
      where: { id: { in: input.leadIds }, organizationId: ctx.organizationId },
      select: { id: true },
    });
    const result = await prisma.campaignLead.createMany({
      data: leads.map((l) => ({ campaignId: campaign.id, leadId: l.id })),
      skipDuplicates: true,
    });
    return { enrolled: result.count, requested: input.leadIds.length };
  },

  send_email: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    const contact = input.contactId
      ? await prisma.contact.findFirst({ where: { id: input.contactId, leadId: lead.id } })
      : await prisma.contact.findFirst({
          where: { leadId: lead.id, email: { not: null }, optedOut: false },
          orderBy: { isPrimary: 'desc' },
        });
    if (!contact?.email) {
      return { sent: false, reason: 'No contact with an email address on this lead. Research one first.' };
    }
    if (contact.optedOut) return { sent: false, reason: 'Contact has opted out — do not message them.' };

    const blocked = await outboundBlockReason(ctx.organizationId);
    // Email channel is stubbed until Mailgun is wired (phase 1): always draft.
    const status = blocked ? 'draft_blocked' : 'draft_pending_approval';
    const result = await recordOutbound({
      ctx,
      leadId: lead.id,
      contactId: contact.id,
      channel: 'EMAIL',
      subject: input.subject,
      body: input.body,
      campaignId: input.campaignId,
      status,
      activityType: 'EMAIL_SENT',
      activitySummary: `Email drafted to ${contact.email}: "${input.subject}"`,
    });
    return {
      sent: false,
      drafted: true,
      ...result,
      note: blocked || 'Email channel is not configured yet — message saved as a draft for review.',
    };
  },

  send_sms: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    const contact = input.contactId
      ? await prisma.contact.findFirst({ where: { id: input.contactId, leadId: lead.id } })
      : await prisma.contact.findFirst({
          where: { leadId: lead.id, phone: { not: null }, optedOut: false },
          orderBy: { isPrimary: 'desc' },
        });
    if (!contact?.phone) {
      return { sent: false, reason: 'No contact with a phone number on this lead. Research one first.' };
    }
    const blocked = await outboundBlockReason(ctx.organizationId);
    const status = blocked ? 'draft_blocked' : 'draft_pending_approval';
    const result = await recordOutbound({
      ctx,
      leadId: lead.id,
      contactId: contact.id,
      channel: 'SMS',
      body: input.body,
      campaignId: input.campaignId,
      status,
      activityType: 'SMS_SENT',
      activitySummary: `SMS drafted to ${contact.phone}`,
    });
    return {
      sent: false,
      drafted: true,
      ...result,
      note: blocked || 'SMS channel (Twilio) is not configured yet — message saved as a draft.',
    };
  },

  place_call: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'CALL_PLACED',
      summary: `AI call queued (voice channel pending setup): ${input.objective}`,
      payload: { objective: input.objective, status: 'pending_channel_setup' },
      campaignId: input.campaignId,
      agentRunId: ctx.runId,
    });
    return {
      queued: true,
      note: 'Voice channel is phase 2 and not configured yet — intent recorded on the lead timeline.',
    };
  },

  schedule_followup: async (input, ctx) => {
    let runAt: Date;
    if (input.runAtIso) {
      runAt = new Date(input.runAtIso);
      if (isNaN(runAt.getTime())) throw new Error(`Invalid runAtIso: ${input.runAtIso}`);
    } else {
      runAt = new Date(Date.now() + (input.delayHours ?? 24) * 3600 * 1000);
    }
    if (input.leadId) await requireLead(input.leadId, ctx.organizationId);

    const job = await prisma.agentJob.create({
      data: {
        organizationId: ctx.organizationId,
        type: input.type || 'FOLLOW_UP',
        objective: input.objective,
        leadId: input.leadId,
        campaignId: input.campaignId,
        runAt,
        createdByRunId: ctx.runId,
      },
    });
    if (input.leadId) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: input.leadId,
        type: 'FOLLOW_UP_SCHEDULED',
        summary: `Follow-up scheduled for ${runAt.toISOString()}`,
        agentRunId: ctx.runId,
      });
    }
    return { jobId: job.id, runAt: runAt.toISOString() };
  },

  update_group_summary: async (input, ctx) => {
    const group = await prisma.leadGroup.findUnique({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: input.groupName } },
    });
    if (!group) throw new Error(`No group named "${input.groupName}"`);
    await prisma.leadGroup.update({ where: { id: group.id }, data: { aiSummary: input.aiSummary } });
    return { ok: true };
  },
};

export async function executeTool(name: string, input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const executor = executors[name];
  if (!executor) throw new Error(`Unknown tool: ${name}`);
  return executor(input, ctx);
}
