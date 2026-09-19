import 'dotenv/config';
import { prisma } from '../src/config/database';
import { findSupersededDrafts, cancelSupersededDraft } from '../src/services/draft-lifecycle.service';

async function main() {
  const [organizationId, campaignId, mode] = process.argv.slice(2);
  if (!organizationId || !campaignId || (mode && mode !== '--apply')) throw new Error('Usage: node --import tsx scripts/reconcile-drafts.ts ORGANIZATION_ID CAMPAIGN_ID [--apply]');
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId }, select: { id: true, name: true } });
  if (!campaign) throw new Error('Campaign does not belong to this organization.');
  const report = await findSupersededDrafts(organizationId, campaignId);
  console.log(JSON.stringify({ mode: mode || 'dry-run', campaign, ...report }, null, 2));
  if (mode === '--apply') {
    let cancelled = 0;
    for (const match of report.matches) if (await cancelSupersededDraft(organizationId, match.draftId, match.sentMessageId)) cancelled++;
    console.log(JSON.stringify({ cancelled, skipped: report.matches.length - cancelled, sent: 0 }));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
