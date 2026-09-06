import { nextStep } from './sequence.service';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { signToken } from '../utils/signing';
import { isWithinQuietHours, localHourIn, resolveLeadTimezone } from '../utils/timezone';

/**
 * Outbound guardrails and campaign cadence bookkeeping.
 *
 * These used to live inside the Engine's tool module, which was fine while the
 * agent was the only thing that sent. The outbound queue sends without an agent
 * involved, and it has to answer to exactly the same rules — a message composed
 * an hour ago must not go out into a lead's quiet hours, or after the lead has
 * unsubscribed in the meantime. Sharing the checks is what keeps the two paths
 * from drifting apart.
 */

/**
 * The one-click unsubscribe target for a contact.
 *
 * Built here rather than at each call site because it had already drifted: the
 * agent and queue paths set it, the human-approval path did not, so every email
 * an operator personally approved went out with no List-Unsubscribe header at
 * all. A single helper makes omitting it require deleting a line rather than
 * merely forgetting one.
 */
export function unsubscribeUrlFor(contactId: string): string {
  return `${config.appPublicUrl}/api/public/unsubscribe?c=${signToken(contactId)}`;
}

/** Compliance stop for opted-out leads. Enforced in code, never by the model. */
export function contactableRefusal(lead: {
  doNotContact: boolean;
  companyName: string;
}): string | null {
  if (!lead.doNotContact) return null;
  return `${lead.companyName} has opted out of being contacted (do-not-contact). Do not message this lead on any channel; move on to other work.`;
}

/**
 * Org kill switch, lead-local quiet hours, and the org's daily send cap.
 * Returns a reason string when sending is blocked, else null.
 */
export async function outboundBlockReason(
  organizationId: string,
  lead?: { timezone?: string | null; state?: string | null } | null
): Promise<string | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) return 'Organization not found';
  if (org.paused) return 'Organization is paused (kill switch) — no outbound allowed. Save drafts instead.';

  // Every outbound email carries an unsubscribe link built from APP_PUBLIC_URL.
  // Pointed at localhost, that link is dead on arrival for every recipient — a
  // compliance failure invisible from inside the app and only discovered through
  // complaints. Refuse rather than send mail nobody can unsubscribe from. Dev is
  // unaffected.
  if (config.isProduction && config.appPublicUrlIsUnreachable) {
    return (
      `APP_PUBLIC_URL is ${config.appPublicUrl}, which no recipient can reach — every ` +
      'unsubscribe and booking link in this email would be dead on arrival. Set APP_PUBLIC_URL ' +
      "to this deployment's real public URL before sending."
    );
  }

  // Quiet hours are evaluated in the LEAD's timezone when known, so we never
  // text/email someone in the middle of their night.
  const { quietHoursStart: start, quietHoursEnd: end } = org;
  const tz = lead ? resolveLeadTimezone(lead) : undefined;
  const hour = tz ? localHourIn(tz) : new Date().getHours();
  if (isWithinQuietHours(start, end, hour)) {
    return `Inside the lead's quiet hours (${start}:00–${end}:00${tz ? ` ${tz}` : ''}) — schedule the send for later instead.`;
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const sentToday = await prisma.activity.count({
    where: {
      organizationId,
      type: { in: ['EMAIL_SENT', 'SMS_SENT', 'CALL_PLACED'] },
      createdAt: { gte: since },
    },
  });
  if (sentToday >= org.dailySendCap) {
    return `Daily send cap reached (${org.dailySendCap}). Schedule remaining sends for tomorrow.`;
  }
  return null;
}

/**
 * A real touch happened on a campaign lead: advance its cadence clock so the
 * mechanical sweep knows when the next touch is due. Keeps working even if the
 * agent forgets — persistence is enforced by the system, not remembered.
 */
export async function recordCampaignTouch(campaignId: string, leadId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  const enrollment = await prisma.campaignLead.findUnique({ where: { campaignId_leadId: { campaignId, leadId } } });
  const following = nextStep(campaign.sequenceSteps, (enrollment?.touchCount ?? 0) + 1);
  const nextTouchAt = campaign.sequenceEnabled ? (following ? new Date(Date.now() + following.delayDays * 86400000) : null) : new Date(Date.now() + campaign.followUpCadenceDays * 86400000);
  await prisma.campaignLead.updateMany({
    where: { campaignId, leadId },
    data: { touchCount: { increment: 1 }, lastTouchAt: new Date(), nextTouchAt },
  });
  // First touch moves the lead into the sequence. The cadence sweep only ever
  // retires IN_SEQUENCE leads, so a lead left on PENDING is worked to its touch
  // limit and then sits there forever, reported as never contacted.
  await prisma.campaignLead.updateMany({
    where: { campaignId, leadId, status: 'PENDING' },
    data: { status: 'IN_SEQUENCE' },
  });
}

/**
 * Hold a campaign lead's next touch until at least the given time. Used when a
 * send has been queued rather than made: the cadence sweep must not batch this
 * lead into another agent run while a composed message is already waiting.
 *
 * Only ever pushes the clock later. The sweep sets a 24h guard when it batches a
 * lead, and overwriting that with a nearer time would make the lead due again
 * while its first message is still unsent — which is how one lead ends up with
 * two composed emails.
 */
export async function deferCampaignTouch(
  campaignId: string,
  leadId: string,
  at: Date
): Promise<void> {
  await prisma.campaignLead.updateMany({
    where: {
      campaignId,
      leadId,
      OR: [{ nextTouchAt: null }, { nextTouchAt: { lt: at } }],
    },
    data: { nextTouchAt: at },
  });
}
