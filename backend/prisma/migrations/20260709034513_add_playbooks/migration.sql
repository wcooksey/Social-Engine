-- CreateEnum
CREATE TYPE "PlaybookScope" AS ENUM ('GLOBAL', 'GROUP', 'CAMPAIGN', 'LEAD_STATUS');

-- CreateEnum
CREATE TYPE "PlaybookChannel" AS ENUM ('ALL', 'EMAIL', 'SMS', 'VOICE');

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PlaybookScope" NOT NULL DEFAULT 'GLOBAL',
    "groupId" TEXT,
    "campaignId" TEXT,
    "leadStatus" "LeadStatus",
    "channel" "PlaybookChannel" NOT NULL DEFAULT 'ALL',
    "instructions" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playbook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Playbook_organizationId_isActive_idx" ON "Playbook"("organizationId", "isActive");

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
