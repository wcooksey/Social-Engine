import { prisma } from '../config/database';

/**
 * Mechanical campaign cadence: the worker sweep (not agent memory) decides
 * when each enrolled lead's next touch is due and queues batched SDR jobs.
 * Batching (~15 leads per job) keeps LLM cost roughly an order of magnitude
 * lower than one run per lead. Replies, opt-outs, and max-touches all stop
 * the drip automatically.
 *
 * This sweep is a GENERATOR: it writes new agent jobs, which write new messages.
 * Deleting what it produced never stops it — only `CampaignLead.pausedAt` (an
 * operator hold, set from the Scheduled page) or taking the campaign out of
 * ACTIVE does.
 */

const BATCH_SIZE = 15;
const MAX_DUE_PER_CAMPAIGN_PER_SWEEP = 60;

/**
 * Return leads that have rested long enough for another pass.
 *
 * Deliberately conservative about who qualifies: still COMPLETED (so they never
 * replied and were never booked), the lead is not opted out or on hold, and the
 * campaign has cycles left. Anything that answered has already moved off
 * COMPLETED and is invisible here.
 */
async function reviveDormantLeads(campaign: {
  id: string;
  reEngageAfterDays: number | null;
  maxCycles: number;
}): Promise<number> {
  if (!campaign.reEngageAfterDays || campaign.maxCycles <= 1) return 0;

  const cutoff = new Date(Date.now() - campaign.reEngageAfterDays * 24 * 3600 * 1000);
  const dormant = await prisma.campaignLead.findMany({
    where: {
      campaignId: campaign.id,
      status: 'COMPLETED',
      dormantSince: { lte: cutoff },
      cycle: { lt: campaign.maxCycles },
      lead: { doNotContact: false, contactReviewReason: null },
      // A held lead stays held across the ninety-day gap. Reviving it would
      // spend one of its cycles on a pass that cannot send.
      pausedAt: null,
    },
    select: { id: true },
    take: MAX_DUE_PER_CAMPAIGN_PER_SWEEP,
  });
  if (dormant.length === 0) return 0;

  // Touch count resets: the next cycle is a fresh sequence, not a continuation.
  const revived = await prisma.campaignLead.updateMany({
    where: { id: { in: dormant.map((d) => d.id) }, status: 'COMPLETED' },
    data: {
      status: 'PENDING',
      touchCount: 0,
      cycle: { increment: 1 },
      dormantSince: null,
      nextTouchAt: new Date(),
    },
  });
  return revived.count;
}

/**
 * Extra instruction for a batch that contains repeat cycles.
 *
 * Two things matter on a second pass: lead with something genuinely new, and
 * re-check the details before writing, because ninety days is long enough for
 * the person to have left.
 */
function cycleGuidance(
  batch: { cycle: number }[],
  angleFor: Map<number, string>
): string {
  const repeats = [...new Set(batch.map((b) => b.cycle).filter((c) => c > 1))];
  if (repeats.length === 0) return '';

  const angles = repeats
    .map((c) => {
      const angle = angleFor.get(c);
      return angle ? `  - cycle ${c}: ${angle}` : null;
    })
    .filter(Boolean)
    .join('\n');

  return (
    `\n\nSome of these leads are on a REPEAT cycle — they were worked before, never replied, ` +
    `and have been left alone since. Two rules for those:\n` +
    `1. Re-verify before writing. Months have passed: check the contact still exists (verify_email) ` +
    `and, if the decision maker has moved on, find their replacement before sending anything.\n` +
    `2. Lead with something NEW. Do not replay the earlier sequence — they already ignored it. ` +
    (angles ? `Use the angle recorded for the cycle:\n${angles}` : 'Find a fresh reason to be in touch.')
  );
}

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

    // Leads that exhausted their touches go dormant rather than simply ending.
    // dormantSince is the clock re-engagement runs on.
    await prisma.campaignLead.updateMany({
      where: {
        campaignId: campaign.id,
        status: 'IN_SEQUENCE',
        touchCount: { gte: campaign.maxTouches },
      },
      data: { status: 'COMPLETED', dormantSince: new Date() },
    });

    // Wake dormant leads for another pass. Only ones that never answered: a
    // reply, a booking or an opt-out all move the row off COMPLETED, so this
    // reaches exactly the people who ignored us.
    const revived = await reviveDormantLeads(campaign);
    if (revived > 0) {
      console.log(`Campaign "${campaign.name}": ${revived} lead(s) revived for a new cycle.`);
    }

    const due = await prisma.campaignLead.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['PENDING', 'IN_SEQUENCE'] },
        touchCount: { lt: campaign.maxTouches },
        OR: [{ nextTouchAt: null }, { nextTouchAt: { lte: new Date() } }],
        lead: { doNotContact: false },
        // Operator hold from the Scheduled page. This is the only field that
        // actually stops a campaign: cancelling the messages it has already
        // written just frees the lead to be batched again on the next pass.
        pausedAt: null,
      },
      orderBy: [{ nextTouchAt: 'asc' }, { createdAt: 'asc' }],
      take: MAX_DUE_PER_CAMPAIGN_PER_SWEEP,
      include: { lead: { select: { companyName: true } } },
    });
    if (due.length === 0) continue;

    // Cycle-specific angle, so a second pass leads with something new rather
    // than replaying the sequence that already failed to land.
    const cycles = await prisma.campaignCycle.findMany({ where: { campaignId: campaign.id } });
    const angleFor = new Map(cycles.map((c) => [c.cycle, c.angle]));

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
            `. For EACH lead below: read its timeline (get_lead_timeline), skip it if it has replied, opted out, or a meeting is already booked; otherwise send the appropriate next touch per the playbooks on the campaign's channels (${campaign.channels.join(', ')}), personalized to its history. Pass campaignId ${campaign.id} on every send so the cadence clock advances. Work through the whole list.` +
            cycleGuidance(batch, angleFor) +
            `\n\nLeads:\n` +
            batch
              .map(
                (b) =>
                  `- ${b.lead.companyName} (leadId: ${b.leadId}, touches so far: ${b.touchCount}` +
                  (b.cycle > 1 ? `, cycle ${b.cycle}` : '') +
                  ')'
              )
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
