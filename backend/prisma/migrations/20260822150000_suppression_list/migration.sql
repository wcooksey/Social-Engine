-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('EMAIL', 'PHONE', 'DOMAIN');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "contactReviewReason" TEXT;

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "originLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Suppression_organizationId_kind_idx" ON "Suppression"("organizationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_organizationId_kind_value_key" ON "Suppression"("organizationId", "kind", "value");

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

