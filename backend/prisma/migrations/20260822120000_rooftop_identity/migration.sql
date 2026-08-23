-- DropIndex
DROP INDEX "Lead_organizationId_domain_key";

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "phoneNormalized" TEXT,
ADD COLUMN     "placeId" TEXT;

-- CreateIndex
CREATE INDEX "Lead_organizationId_domain_idx" ON "Lead"("organizationId", "domain");

-- CreateIndex
CREATE INDEX "Lead_organizationId_phoneNormalized_idx" ON "Lead"("organizationId", "phoneNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_organizationId_placeId_key" ON "Lead"("organizationId", "placeId");


-- Backfill the normalized phone for existing leads so dedup keeps working for
-- rows created before this column existed. Matches normalizePhone(): digits
-- only, last 10, and null when there are fewer than 10.
UPDATE "Lead"
SET "phoneNormalized" = RIGHT(REGEXP_REPLACE("phone", '\D', '', 'g'), 10)
WHERE "phone" IS NOT NULL
  AND LENGTH(REGEXP_REPLACE("phone", '\D', '', 'g')) >= 10;
