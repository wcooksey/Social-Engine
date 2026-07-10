-- CreateEnum
CREATE TYPE "CoverageCellStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'EMPTY');

-- CreateTable
CREATE TABLE "CoverageCell" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" "CoverageCellStatus" NOT NULL DEFAULT 'PENDING',
    "leadsFound" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverageCell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoverageCell_organizationId_status_idx" ON "CoverageCell"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CoverageCell_groupId_status_idx" ON "CoverageCell"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageCell_groupId_query_key" ON "CoverageCell"("groupId", "query");

-- AddForeignKey
ALTER TABLE "CoverageCell" ADD CONSTRAINT "CoverageCell_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageCell" ADD CONSTRAINT "CoverageCell_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
