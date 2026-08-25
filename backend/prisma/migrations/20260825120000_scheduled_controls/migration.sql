-- Operator holds over scheduled work.
--
-- Every layer that can fire on its own now has a resumable "held" state, so
-- stopping something no longer means destroying it.

-- AlterEnum: a paused job keeps its objective and runAt but is invisible to the
-- worker's claim query (which matches on PENDING).
ALTER TYPE "AgentJobStatus" ADD VALUE 'PAUSED';

-- AlterTable: the cadence sweep's hold. Campaigns generate brand-new touches on
-- every pass, so this is the only field that actually stops one.
ALTER TABLE "CampaignLead" ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- Drives the Scheduled page's queued-message feed, which filters by org through
-- Conversation and orders by due time.
CREATE INDEX IF NOT EXISTS "Message_scheduledAt_idx" ON "Message"("scheduledAt");

-- Campaign holds are listed and bulk-cleared by campaign.
CREATE INDEX IF NOT EXISTS "CampaignLead_campaignId_pausedAt_idx" ON "CampaignLead"("campaignId", "pausedAt");
