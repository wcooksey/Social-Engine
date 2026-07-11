-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'EMAIL_OPENED';
ALTER TYPE "ActivityType" ADD VALUE 'EMAIL_CLICKED';

-- CreateEnum
CREATE TYPE "AutopilotGoalStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "autoEnrollGroupId" TEXT;

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "lastInboxSweepAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AutopilotGoal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL DEFAULT 'COORDINATOR',
    "status" "AutopilotGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "cadenceHours" INTEGER NOT NULL DEFAULT 24,
    "leadGroupId" TEXT,
    "campaignId" TEXT,
    "targetLeadCount" INTEGER,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastQueuedAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdByRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopilotGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutopilotGoal_organizationId_status_idx" ON "AutopilotGoal"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AutopilotGoal_status_nextRunAt_idx" ON "AutopilotGoal"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Campaign_autoEnrollGroupId_idx" ON "Campaign"("autoEnrollGroupId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_autoEnrollGroupId_fkey" FOREIGN KEY ("autoEnrollGroupId") REFERENCES "LeadGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopilotGoal" ADD CONSTRAINT "AutopilotGoal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopilotGoal" ADD CONSTRAINT "AutopilotGoal_leadGroupId_fkey" FOREIGN KEY ("leadGroupId") REFERENCES "LeadGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopilotGoal" ADD CONSTRAINT "AutopilotGoal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
