ALTER TABLE "Lead" ADD COLUMN "engagementChannel" TEXT, ADD COLUMN "coldOutreachHeldAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "emailVerifiedAddress" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "sequenceEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "sequenceSteps" JSONB NOT NULL DEFAULT '[]';
-- Existing engaged leads must not restart cold outreach after deployment.
UPDATE "Lead" SET "coldOutreachHeldAt" = CURRENT_TIMESTAMP WHERE "status" IN ('ENGAGED','INTERESTED','CUSTOMER') OR EXISTS (SELECT 1 FROM "CampaignLead" cl WHERE cl."leadId" = "Lead"."id" AND cl."status" = 'REPLIED');
ALTER TABLE "Message" ADD COLUMN "sequenceKey" TEXT, ADD COLUMN "approvedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Message_sequenceKey_key" ON "Message"("sequenceKey");
CREATE TABLE "EmailEventReceipt" ("id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "mailboxId" TEXT, "event" TEXT NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "EmailEventReceipt_pkey" PRIMARY KEY ("id"));
CREATE INDEX "EmailEventReceipt_organizationId_receivedAt_idx" ON "EmailEventReceipt"("organizationId", "receivedAt");
ALTER TABLE "Message" ADD COLUMN "isConversationReply" BOOLEAN NOT NULL DEFAULT false;
