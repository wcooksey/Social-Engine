import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';

/** Normalize a website/URL/domain string to a bare dedup key like "sunshinetoyota.com". */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split(/[/?#]/)[0];
  return value.includes('.') ? value : null;
}

export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export interface UpsertLeadInput {
  companyName: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  industry?: string;
  source?: string;
  groupId?: string;
  groupName?: string;
  status?: string;
  aiSummary?: string;
  socials?: Record<string, string>;
}

class LeadService {
  /**
   * Create-or-update with dedup. Match order: normalized domain, then
   * (companyName + city/state), then normalized phone. Used by both the REST
   * API and the Engine's upsert_lead tool so the AI can never create dupes.
   */
  async upsertLead(organizationId: string, input: UpsertLeadInput) {
    if (!input.companyName?.trim()) throw new AppError('companyName is required');

    const domain = normalizeDomain(input.website);
    const phone = normalizePhone(input.phone);

    let groupId = input.groupId ?? null;
    if (!groupId && input.groupName) {
      const group = await prisma.leadGroup.upsert({
        where: { organizationId_name: { organizationId, name: input.groupName.trim() } },
        create: { organizationId, name: input.groupName.trim() },
        update: {},
      });
      groupId = group.id;
    }

    let existing = null;
    if (domain) {
      existing = await prisma.lead.findUnique({
        where: { organizationId_domain: { organizationId, domain } },
      });
    }
    if (!existing) {
      existing = await prisma.lead.findFirst({
        where: {
          organizationId,
          companyName: { equals: input.companyName.trim(), mode: 'insensitive' },
          ...(input.city ? { city: { equals: input.city, mode: 'insensitive' } } : {}),
          ...(input.state ? { state: { equals: input.state, mode: 'insensitive' } } : {}),
        },
      });
    }
    if (!existing && phone) {
      const candidates = await prisma.lead.findMany({
        where: { organizationId, phone: { not: null } },
        select: { id: true, phone: true },
        take: 2000,
      });
      const match = candidates.find((c) => normalizePhone(c.phone) === phone);
      if (match) existing = await prisma.lead.findUnique({ where: { id: match.id } });
    }

    const data = {
      companyName: input.companyName.trim(),
      website: input.website?.trim() || undefined,
      domain: domain || undefined,
      phone: input.phone?.trim() || undefined,
      address: input.address || undefined,
      city: input.city || undefined,
      state: input.state || undefined,
      postalCode: input.postalCode || undefined,
      country: input.country || undefined,
      industry: input.industry || undefined,
      source: input.source || undefined,
      aiSummary: input.aiSummary || undefined,
      socials: input.socials ? (input.socials as Prisma.InputJsonValue) : undefined,
      ...(groupId ? { groupId } : {}),
      ...(input.status ? { status: input.status as never } : {}),
    };

    if (existing) {
      const updated = await prisma.lead.update({ where: { id: existing.id }, data });
      return { lead: updated, created: false };
    }
    const created = await prisma.lead.create({ data: { ...data, organizationId } });
    return { lead: created, created: true };
  }

  async searchLeads(
    organizationId: string,
    params: {
      search?: string;
      status?: string;
      groupId?: string;
      state?: string;
      page?: number;
      pageSize?: number;
    }
  ) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 25));

    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.state ? { state: { equals: params.state, mode: 'insensitive' } } : {}),
      ...(params.search
        ? {
            OR: [
              { companyName: { contains: params.search, mode: 'insensitive' } },
              { domain: { contains: params.search.toLowerCase() } },
              { city: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          group: { select: { id: true, name: true } },
          _count: { select: { contacts: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.lead.count({ where }),
    ]);

    return {
      leads: leads.map((l) => ({ ...l, contactCount: l._count.contacts })),
      total,
      page,
      pageSize,
    };
  }

  async logActivity(input: {
    organizationId: string;
    leadId: string;
    type: string;
    summary: string;
    payload?: Record<string, unknown>;
    campaignId?: string;
    agentRunId?: string;
  }) {
    return prisma.activity.create({
      data: {
        organizationId: input.organizationId,
        leadId: input.leadId,
        type: input.type as never,
        summary: input.summary,
        payload: input.payload ? (input.payload as Prisma.InputJsonValue) : undefined,
        campaignId: input.campaignId,
        agentRunId: input.agentRunId,
      },
    });
  }
}

export const leadService = new LeadService();
