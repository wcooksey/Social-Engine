import { transitionPreview } from '../services/sequence-transition.service';
import { findSupersededDrafts, cancelSupersededDraft } from '../services/draft-lifecycle.service';
import { automationSafetyReason, emailSafetyReason } from '../services/send-safety.service';
import { outboundBlockReason } from '../services/outbound.service';
import { resolveSenderIdentity, withSignature } from '../services/identity.service';
import { getSendingOverview, resolveSenderDecision } from '../services/sender.service';
import { nextStep } from '../services/sequence.service';
import { randomUUID } from 'crypto';
import { stepsFrom, validateStep } from '../services/sequence.service';
import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';

import { campaignGroupWhere, requireGroup } from '../services/group-scope';

const router = Router();

router.get('/:id/superseded-drafts', asyncHandler(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  if (!campaign) throw new AppError('Campaign not found', 404);
  res.json({ success: true, data: await findSupersededDrafts(req.user!.organizationId, campaign.id) });
}));
router.post('/:id/superseded-drafts/cancel', asyncHandler(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  if (!campaign) throw new AppError('Campaign not found', 404);
  const pairs = req.body?.matches;
  if (!Array.isArray(pairs) || pairs.length > 500 || pairs.some(p => typeof p?.draftId !== 'string' || typeof p?.sentMessageId !== 'string')) throw new AppError('Provide up to 500 reviewed draft/message pairs.');
  let cancelled = 0;
  for (const pair of pairs) {
    const scoped = await prisma.message.findFirst({ where: { id: pair.draftId, campaignId: campaign.id, conversation: { organizationId: req.user!.organizationId } }, select: { id: true } });
    if (scoped && await cancelSupersededDraft(req.user!.organizationId, pair.draftId, pair.sentMessageId)) cancelled++;
  }
  res.json({ success: true, data: { cancelled, skipped: pairs.length - cancelled } });
}));

router.get('/:id/preview', asyncHandler(async (req, res) => {
  const enrollment = await prisma.campaignLead.findFirst({ where: { campaignId: req.params.id, leadId: String(req.query.leadId || ''), campaign: { organizationId: req.user!.organizationId } }, include: { campaign: true, lead: { include: { contacts: true } } } });
  if (!enrollment) throw new AppError('Enrolled lead not found', 404);
  const { campaign, lead } = enrollment;
  const blockers: string[] = [];
  const safety = await automationSafetyReason(req.user!.organizationId, lead.id, 'EMAIL', campaign.id);
  const limits = await outboundBlockReason(req.user!.organizationId, lead);
  if (safety) blockers.push(safety);
  if (limits) blockers.push(limits);
  const step = campaign.sequenceEnabled ? nextStep(campaign.sequenceSteps, enrollment.touchCount) : null;
  if (step) {
    const existing = await prisma.message.findUnique({ where: { sequenceKey: `${campaign.id}:${lead.id}:${step.id}` }, select: { status: true } });
    if (existing) blockers.push(`This step already has a message: ${existing.status}. Inspect it in Inbox or Scheduled; it will not be generated again.`);
  }
  if (!step) blockers.push(campaign.sequenceEnabled ? 'Waiting for another approved step.' : 'AI cadence: no fixed next email to preview. Create an approval-required draft to review the actual copy.');
  const previous = enrollment.touchCount ? await prisma.message.findFirst({ where: { campaignId: campaign.id, direction: 'OUTBOUND', sentAt: { not: null }, conversation: { organizationId: req.user!.organizationId, leadId: lead.id, channel: 'EMAIL' } }, orderBy: { sentAt: 'desc' }, include: { conversation: true } }) : null;
  if (enrollment.touchCount && !previous) blockers.push('Original sent message is unavailable; follow-up will not send.');
  let contact = null;
  for (const candidate of lead.contacts) { if (enrollment.touchCount && candidate.id !== previous?.conversation.contactId) continue; if (!await emailSafetyReason(req.user!.organizationId, candidate.id)) { contact = candidate; break; } }
  if (!contact) blockers.push('No current, verified, unsuppressed email address.');
  const identity = await resolveSenderIdentity(req.user!.organizationId, { lead, channel: 'EMAIL' });
  if (!identity.postalAddress) blockers.push('Sender postal footer is missing.');
  const conversation = contact ? await prisma.conversation.findFirst({ where: { organizationId: req.user!.organizationId, leadId: lead.id, contactId: contact.id, channel: 'EMAIL' } }) : null;
  const decision = await resolveSenderDecision(req.user!.organizationId, { purpose: 'COLD_OUTREACH', playbookId: identity.routingPlaybookId, conversationId: conversation?.id, preferAddress: identity.email });
  if (!decision.sender) blockers.push(decision.reason || 'No sender available.');
  if (campaign.mode === 'APPROVAL_REQUIRED') blockers.push('The generated message must be approved in Inbox before it can send.');
  if (step && enrollment.lastTouchAt) {
    const due = new Date(enrollment.lastTouchAt.getTime() + step.delayDays * 86400000);
    if (due > new Date()) blockers.push('Sequence delay: eligible after ' + due.toISOString());
  }
  res.json({ success: true, data: { subject: step?.subject.split('{{companyName}}').join(lead.companyName) ?? null, body: step ? withSignature(step.body.split('{{companyName}}').join(lead.companyName), identity) : null, sender: decision.sender?.fromEmail ?? null, blockers, nextEligibleAt: decision.retryAt ?? null } });
}));

function serialize(c: { _count?: { campaignLeads: number } } & Record<string, unknown>) {
  const { _count, ...rest } = c;
  return { ...rest, leadCount: _count?.campaignLeads ?? 0 };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groupId = await requireGroup(req.user!.organizationId, req.query.groupId);
    const campaigns = await prisma.campaign.findMany({
      where: { organizationId: req.user!.organizationId, ...(groupId ? campaignGroupWhere(groupId) : {}) },
      include: { autoEnrollGroup: { select: { id: true, name: true } }, playbooks: { select: { id: true, name: true, isActive: true } }, _count: { select: { campaignLeads: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: campaigns.map(serialize) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    const groupId = await requireGroup(req.user!.organizationId, req.body.groupId);
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        autoEnrollGroupId: groupId,
        offer: req.body.offer || null,
        channels: req.body.channels || ['EMAIL'],
        mode: req.body.mode || 'APPROVAL_REQUIRED',
        followUpCadenceDays: req.body.followUpCadenceDays ?? 3,
        maxTouches: req.body.maxTouches ?? 6,
      },
    });
    res.status(201).json({ success: true, data: { ...campaign, leadCount: 0 } });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const groupId = await requireGroup(req.user!.organizationId, req.query.groupId);
    const leadPageSize = Math.min(200, Math.max(1, parseInt(String(req.query.leadPageSize ?? '200'), 10) || 200));
    const requestedLeadPage = Math.max(1, parseInt(String(req.query.leadPage ?? '1'), 10) || 1);
    const leadTotal = await prisma.campaignLead.count({
      where: { campaignId: req.params.id, campaign: { organizationId: req.user!.organizationId }, ...(groupId ? { lead: { groupId } } : {}) },
    });
    const leadPage = Math.min(requestedLeadPage, Math.max(1, Math.ceil(leadTotal / leadPageSize)));
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId, ...(groupId ? campaignGroupWhere(groupId) : {}) },
      include: {
        _count: { select: { campaignLeads: true } },
        autoEnrollGroup: { select: { id: true, name: true } },
        campaignLeads: {
          ...(groupId ? { where: { lead: { groupId } } } : {}),
          include: {
            lead: {
              select: {
                id: true,
                companyName: true,
                status: true,
                city: true,
                state: true,
                doNotContact: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: leadPageSize,
          skip: (leadPage - 1) * leadPageSize,
        },
      },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
    res.json({ success: true, data: { ...serialize(campaign as never), leadTotal, leadPage } });
  })
);

router.get('/:id/sending-summary', asyncHandler(async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
  if (!campaign) throw new AppError('Campaign not found', 404);
  const now = new Date(); const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  const [rows, sent, waiting, sending] = await Promise.all([
    prisma.campaignLead.findMany({ where: { campaignId: campaign.id }, include: { lead: { include: { contacts: true } } } }),
    prisma.message.findMany({ where: { campaignId: campaign.id, direction: 'OUTBOUND', sentAt: { gte: today } }, select: { provenance: true } }),
    prisma.message.groupBy({ by: ['status'], where: { campaignId: campaign.id, direction: 'OUTBOUND', sentAt: null }, _count: true }),
    getSendingOverview(req.user!.organizationId)
  ]);
  const reasons: Record<string, number> = {};
  const count = (reason: string) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  for (const row of rows) {
    if (row.pausedAt || ['REMOVED', 'REPLIED'].includes(row.status) || row.lead.doNotContact || row.lead.coldOutreachHeldAt || ['ARCHIVED','NOT_INTERESTED','ENGAGED','INTERESTED','CUSTOMER'].includes(row.lead.status)) { count('Excluded, replied, or held'); continue; }
    if (row.status === 'COMPLETED' || row.touchCount >= campaign.maxTouches) { count('Sequence finished'); continue; }
    if (campaign.status !== 'ACTIVE') { count('Campaign paused or inactive'); continue; }
    let usable = false;
    for (const contact of row.lead.contacts) { if (!await emailSafetyReason(req.user!.organizationId, contact.id)) { usable = true; break; } }
    if (!usable) { count('No current verified, unsuppressed email'); continue; }
    const step = nextStep(campaign.sequenceSteps, row.touchCount);
    const due = row.lastTouchAt && step ? new Date(row.lastTouchAt.getTime() + step.delayDays * 86400000) : row.nextTouchAt;
    if ((due && due > now) || (row.nextTouchAt && row.nextTouchAt > now)) count('Next touch not due');
    else count(row.touchCount ? 'Follow-up due — subject to send checks' : 'Introduction due — subject to send checks');
  }
  const mailboxes = sending.domains.filter(d => d.purpose === 'COLD_OUTREACH' && ['ACTIVE', 'WARMING'].includes(d.status) && d.dns.spf && d.dns.dkim).flatMap(d => d.mailboxes).filter(m => !['PAUSED', 'RETIRED'].includes(m.status) && (!m.pausedUntil || m.pausedUntil <= now));
  const remainingCapacity = mailboxes.reduce((sum, m) => sum + m.remainingToday, 0);
  const followups = sent.filter(m => (m.provenance as any)?.outreachKind === 'followup').length;
  res.json({ success: true, data: { day: today.toISOString().slice(0, 10), remainingCapacity, introductionsSent: sent.length - followups, followupsSent: followups, reasons, messages: waiting.map(r => ({ status: r.status || 'unknown', count: r._count })), status: campaign.status } });
}));

/** Explicit review boundary for continuing a paused historical one-touch campaign. */
router.get('/:id/continuation', asyncHandler(async (req, res) => {
  try {
    const plan = await transitionPreview(prisma, req.user!.organizationId, req.params.id);
    res.json({ success: true, data: { eligible: plan.eligible, excluded: plan.excluded } });
  } catch (err) { throw new AppError((err as Error).message); }
}));
router.post('/:id/continuation', asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body.steps) || req.body.steps.length !== 3) throw new AppError('Provide an introduction and exactly two follow-ups.');
  const steps = req.body.steps.map((s: any) => validateStep({ ...s, id: randomUUID() }));
  if (steps.some((s: any) => !s.approved) || steps[1].delayDays !== 2 || steps[2].delayDays !== 3) throw new AppError('Approve all three emails with follow-ups after 2 and 3 days.');
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`;
      const plan = await transitionPreview(tx, req.user!.organizationId, req.params.id);
      const ids = plan.eligible.map((r: any) => r.id);
      if (!Array.isArray(req.body.eligibleIds) || JSON.stringify([...ids].sort()) !== JSON.stringify([...req.body.eligibleIds].sort())) throw new Error('Eligibility changed. Refresh the preview before applying.');
      const pending = await tx.message.count({ where: { campaignId: req.params.id, status: { in: ['scheduled', 'sending', 'draft_pending_approval'] } } });
      if (pending) throw new Error('Resolve existing queued or approval-pending messages before converting this campaign.');
      for (const row of plan.eligible) await tx.campaignLead.update({ where: { id: row.id }, data: { status: row.touchCount ? 'IN_SEQUENCE' : 'PENDING', dormantSince: null, lastTouchAt: row.lastTouchAt, nextTouchAt: row.lastTouchAt ? new Date(row.lastTouchAt.getTime() + 2 * 86400000) : null } });
      // Excluded enrollments remain excluded, including completed records with unsafe history.
      await tx.campaignLead.updateMany({ where: { campaignId: req.params.id, id: { notIn: ids }, status: { in: ['PENDING', 'IN_SEQUENCE'] } }, data: { pausedAt: new Date() } });
      return tx.campaign.update({ where: { id: req.params.id }, data: { sequenceEnabled: true, autoEnrollGroupId: null, sequenceSteps: steps, maxTouches: 3, reEngageAfterDays: null, maxCycles: 1 } });
    }, { timeout: 30000 });
    res.json({ success: true, data: result });
  } catch (err) { throw new AppError((err as Error).message); }
}));

/** Append-only sequences preserve each enrolled lead's position. Draft steps can be approved later. */
router.post('/:id/sequence', asyncHandler(async (req, res) => {
  let step;
  try { step = validateStep({ ...req.body, id: randomUUID() }); } catch (err) { throw new AppError((err as Error).message); }
  const updated = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`;
    const campaign = await tx.campaign.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (!campaign.sequenceEnabled) {
      if (campaign.status === 'ACTIVE' || await tx.campaignLead.count({ where: { campaignId: campaign.id, touchCount: { gt: 0 } } }) || await tx.message.count({ where: { campaignId: campaign.id } })) throw new AppError('Start an explicit sequence on a draft or paused campaign with no previous touches or messages. Existing campaign history cannot be reinterpreted as sequence steps.');
    }
    const steps = stepsFrom(campaign.sequenceSteps);
    if (steps.length >= 100) throw new AppError('Maximum 100 steps.');
    return tx.campaign.update({ where: { id: campaign.id }, data: { sequenceEnabled: true, sequenceSteps: [...steps, step] as any, maxTouches: steps.length + 1, channels: ['EMAIL'], reEngageAfterDays: null, maxCycles: 1 } });
  });
  res.json({ success: true, data: updated });
}));
router.patch('/:id/sequence/:stepId', asyncHandler(async (req, res) => {
  const updated = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`;
    const campaign = await tx.campaign.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } });
    if (!campaign) throw new AppError('Campaign not found', 404);
    const steps = stepsFrom(campaign.sequenceSteps);
    const index = steps.findIndex(s => s.id === req.params.stepId);
    if (index < 0) throw new AppError('Step not found', 404);
    if (steps[index].approved) throw new AppError('Approved steps are immutable. Pause the campaign to stop sending; append new content as a new step.');
    try { steps[index] = validateStep({ ...req.body, id: steps[index].id }); } catch (err) { throw new AppError((err as Error).message); }
    return tx.campaign.update({ where: { id: campaign.id }, data: { sequenceSteps: steps as any } });
  });
  res.json({ success: true, data: updated });
}));

/** Everything that has happened on this campaign, newest first (paginated). */
router.get(
  '/:id/activity',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      select: { id: true },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = 25;
    const where = { campaignId: campaign.id };
    const [activities, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { lead: { select: { id: true, companyName: true } } },
      }),
      prisma.activity.count({ where }),
    ]);
    res.json({ success: true, data: { activities, total, page, pageSize } });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Campaign not found', 404);

    const allowed = ['name', 'offer', 'channels', 'mode', 'status', 'followUpCadenceDays', 'maxTouches'] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }

    if (existing.sequenceEnabled) {
      delete data.channels; delete data.maxTouches; delete data.followUpCadenceDays;
      if (req.body.reEngageAfterDays || (req.body.maxCycles && req.body.maxCycles !== 1)) throw new AppError('Explicit sequences do not repeat. Append an approved step instead.');
    }

    if ('name' in data) {
      if (typeof data.name !== 'string' || !data.name.trim()) throw new AppError('Campaign name cannot be empty');
      data.name = data.name.trim();
    }
    if ('mode' in data && !['AUTONOMOUS', 'APPROVAL_REQUIRED'].includes(String(data.mode))) throw new AppError('Invalid sending mode');
    for (const key of ['followUpCadenceDays', 'maxTouches'] as const) {
      if (key in data) {
        const value = Number(data[key]);
        if (!Number.isInteger(value) || value < 1 || value > 365) throw new AppError('Cadence and maximum touches must be whole numbers between 1 and 365');
        data[key] = value;
      }
    }

    // Re-engagement. Blank or null turns it off — one pass, then done.
    if ('reEngageAfterDays' in req.body) {
      const raw = req.body.reEngageAfterDays;
      if (raw === null || raw === '') {
        data.reEngageAfterDays = null;
      } else {
        const days = Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > 730) {
          throw new AppError('Re-engage after must be between 1 and 730 days, or blank for never');
        }
        data.reEngageAfterDays = days;
      }
    }
    if ('maxCycles' in req.body) {
      const cycles = Number(req.body.maxCycles);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > 12) {
        throw new AppError('Total passes must be between 1 and 12');
      }
      data.maxCycles = cycles;
    }

    const campaign = await prisma.campaign.update({ where: { id: existing.id }, data });
    res.json({ success: true, data: campaign });
  })
);

/**
 * What this campaign is about to do — the next fortnight of scheduled touches,
 * with enough context to judge and change each one.
 */
router.get(
  '/:id/schedule',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
    const horizon = new Date(Date.now() + days * 24 * 3600 * 1000);

    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? '200'), 10) || 200));
    const requestedPage = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const upcomingWhere = {
      campaignId: campaign.id,
      status: { in: ['PENDING', 'IN_SEQUENCE'] as ('PENDING' | 'IN_SEQUENCE')[] },
      OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: horizon } }],
    };
    const upcomingTotal = await prisma.campaignLead.count({ where: upcomingWhere });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(upcomingTotal / pageSize)));

    const [upcoming, cycles, dormantCount] = await Promise.all([
      prisma.campaignLead.findMany({
        where: upcomingWhere,
        orderBy: [{ nextTouchAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: pageSize,
        skip: (page - 1) * pageSize,
        include: {
          lead: {
            select: {
              id: true,
              companyName: true,
              city: true,
              status: true,
              doNotContact: true,
              contactReviewReason: true,
            },
          },
        },
      }),
      prisma.campaignCycle.findMany({ where: { campaignId: campaign.id }, orderBy: { cycle: 'asc' } }),
      prisma.campaignLead.count({ where: { campaignId: campaign.id, status: 'COMPLETED' } }),
    ]);

    res.json({
      success: true,
      data: {
        days,
        reEngageAfterDays: campaign.reEngageAfterDays,
        maxCycles: campaign.maxCycles,
        followUpCadenceDays: campaign.followUpCadenceDays,
        maxTouches: campaign.maxTouches,
        // Leads resting between passes — the pool re-engagement will draw from.
        dormantCount,
        upcomingTotal,
        page,
        cycles,
        upcoming: upcoming.map((cl) => ({
          id: cl.id,
          leadId: cl.leadId,
          companyName: cl.lead.companyName,
          city: cl.lead.city,
          leadStatus: cl.lead.status,
          sequenceStatus: cl.status,
          touchCount: cl.touchCount,
          cycle: cl.cycle,
          nextTouchAt: cl.nextTouchAt,
          lastTouchAt: cl.lastTouchAt,
          // Surfaced so the list explains itself rather than silently skipping.
          blocked: cl.lead.doNotContact
            ? 'Lead has opted out'
            : cl.lead.contactReviewReason
              ? 'On hold pending an ownership check'
              : null,
        })),
      },
    });
  })
);

/** Reschedule or remove one lead's next touch, from the schedule view. */
router.patch(
  '/:id/schedule/:campaignLeadId',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const row = await prisma.campaignLead.findFirst({
      where: { id: req.params.campaignLeadId, campaignId: campaign.id },
    });
    if (!row) throw new AppError('Lead is not enrolled in this campaign', 404);

    const data: Record<string, unknown> = {};
    if ('nextTouchAt' in req.body) {
      const raw = req.body.nextTouchAt;
      if (raw === null || raw === '') {
        // Null means "due now" to the cadence sweep.
        data.nextTouchAt = null;
      } else {
        const when = new Date(String(raw));
        if (Number.isNaN(when.getTime())) throw new AppError('nextTouchAt must be a date');
        data.nextTouchAt = when;
      }
    }
    if ('status' in req.body) {
      const allowed = ['PENDING', 'IN_SEQUENCE', 'COMPLETED', 'REMOVED'];
      const status = String(req.body.status);
      if (!allowed.includes(status)) throw new AppError(`status must be one of ${allowed.join(', ')}`);
      data.status = status;
      // Taking a lead out by hand should not leave it eligible for the
      // re-engagement sweep to pull straight back in.
      if (status === 'REMOVED' || status === 'COMPLETED') data.dormantSince = null;
    }
    if (Object.keys(data).length === 0) throw new AppError('Nothing to change');

    const updated = await prisma.campaignLead.update({ where: { id: row.id }, data });
    res.json({ success: true, data: updated });
  })
);

/** Create or edit the angle a given cycle leads with. */
router.put(
  '/:id/cycles/:cycle',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const cycle = parseInt(req.params.cycle, 10);
    if (!Number.isInteger(cycle) || cycle < 2 || cycle > 12) {
      throw new AppError('Cycle must be between 2 and 12 — the first pass uses the campaign offer');
    }
    const angle = String(req.body?.angle ?? '').trim();
    if (!angle) throw new AppError('angle is required — what is new this time round?');

    const saved = await prisma.campaignCycle.upsert({
      where: { campaignId_cycle: { campaignId: campaign.id, cycle } },
      create: { campaignId: campaign.id, cycle, angle },
      update: { angle },
    });
    res.json({ success: true, data: saved });
  })
);

router.delete(
  '/:id/cycles/:cycle',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
    await prisma.campaignCycle.deleteMany({
      where: { campaignId: campaign.id, cycle: parseInt(req.params.cycle, 10) },
    });
    res.json({ success: true, data: null });
  })
);

router.post(
  '/:id/leads',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);

    const leadIds: string[] = req.body.leadIds || [];
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, organizationId: req.user!.organizationId },
      select: { id: true },
    });
    const result = await prisma.campaignLead.createMany({
      data: leads.map((l) => ({ campaignId: campaign.id, leadId: l.id })),
      skipDuplicates: true,
    });
    res.json({ success: true, data: { added: result.count } });
  })
);

export default router;
