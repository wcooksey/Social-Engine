import { prisma } from '../config/database';

/**
 * Mechanical campaign cadence: the worker sweep (not agent memory) decides
 * when each enrolled lead's next touch is due and queues batched SDR jobs.
 * Batching (~15 leads per job) keeps LLM cost roughly an order of magnitude
 * lower than one run per lead. Replies, opt-outs, and max-touches all stop
 * the drip automatically.
 */

const BATCH_SIZE = 15;
const MAX_DUE_PER_CAMPAIGN_PER_SWEEP = 60;

export async function runCadenceSweep(): Promise<number> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', organization: { paused: false } },
  });

  let jobsQueued = 0;
  for (const campaign of campaigns) {
    // Auto-enrollment: leads that landed in the linked group since the last
    // sweep enter the campaign mechanically — sourcing flows into outreach
    // without an agent having to remember to enroll them.
    if (campaign.autoEnrollGroupId) {
      const newLeads = await prisma.lead.findMany({
        where: {
          groupId: campaign.autoEnrollGroupId,
          organizationId: campaign.organizationId,
          doNotContact: false,
          campaignLeads: { none: { campaignId: campaign.id } },
        },
        select: { id: true },
        take: 500,
      });
      if (newLeads.length) {
        await prisma.campaignLead.createMany({
          data: newLeads.map((l) => ({ campaignId: campaign.id, leadId: l.id })),
          skipDuplicates: true,
        });
      }
    }

    // Leads that exhausted their touches are done with the sequence.
    await prisma.campaignLead.updateMany({
      where: {
        campaignId: campaign.id,
        status: 'IN_SEQUENCE',
        touchCount: { gte: campaign.maxTouches },
      },
      data: { status: 'COMPLETED' },
    });

    const due = await prisma.campaignLead.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['PENDING', 'IN_SEQUENCE'] },
        touchCount: { lt: campaign.maxTouches },
        OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: new Date() } }],
        lead: { doNotContact: false },
      },
      orderBy: [{ nextTouchAt: 'asc' }, { createdAt: 'asc' }],
      take: MAX_DUE_PER_CAMPAIGN_PER_SWEEP,
      include: { lead: { select: { companyName: true } } },
    });
    if (due.length === 0) continue;

    // Defer the batch a day so a pending/slow job isn't double-queued next
    // sweep; the actual send resets the real cadence clock via touch tracking.
    const requeueGuard = new Date(Date.now() + 24 * 3600 * 1000);

    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE);
      await prisma.agentJob.create({
        data: {
          organizationId: campaign.organizationId,
          campaignId: campaign.id,
          type: 'CAMPAIGN_STEP',
          role: 'SDR',
          objective:
            `Cadence touch due for ${batch.length} leads in campaign "${campaign.name}"` +
            (campaign.offer ? ` (offer: ${campaign.offer.slice(0, 300)})` : '') +
            `. For EACH lead below: read its timeline (get_lead_timeline), skip it if it has replied, opted out, or a meeting is already booked; otherwise send the appropriate next touch per the playbooks on the campaign's channels (${campaign.channels.join(', ')}), personalized to its history. Pass campaignId ${campaign.id} on every send so the cadence clock advances. Work through the whole list.\n\nLeads:\n` +
            batch
              .map((b) => `- ${b.lead.companyName} (leadId: ${b.leadId}, touches so far: ${b.touchCount})`)
              .join('\n'),
          runAt: new Date(),
        },
      });
      await prisma.campaignLead.updateMany({
        where: { id: { in: batch.map((b) => b.id) } },
        data: { nextTouchAt: requeueGuard },
      });
      jobsQueued++;
    }
  }
  return jobsQueued;
}
