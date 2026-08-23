-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "maxCycles" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "reEngageAfterDays" INTEGER DEFAULT 90;

-- AlterTable
ALTER TABLE "CampaignLead" ADD COLUMN     "cycle" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dormantSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Playbook" ADD COLUMN     "icp" JSONB;

-- CreateTable
CREATE TABLE "CampaignCycle" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "angle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCycle_campaignId_cycle_key" ON "CampaignCycle"("campaignId", "cycle");

-- AddForeignKey
ALTER TABLE "CampaignCycle" ADD CONSTRAINT "CampaignCycle_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

