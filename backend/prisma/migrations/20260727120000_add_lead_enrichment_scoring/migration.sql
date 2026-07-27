-- CreateEnum
CREATE TYPE "EnrichmentTier" AS ENUM ('NONE', 'MINIMAL', 'PARTIAL', 'GOOD', 'RICH');

-- AlterTable
-- A confirmed-deliverable address gets its own column: any non-null
-- "emailStatus" already means "suppressed, do not send here".
ALTER TABLE "Contact" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Lead"
  ADD COLUMN     "enrichmentScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "enrichmentTier" "EnrichmentTier" NOT NULL DEFAULT 'NONE',
  ADD COLUMN     "emailCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "phoneCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "contactCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "enrichmentGaps" JSONB,
  ADD COLUMN     "enrichmentVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "lastEnrichedAt" TIMESTAMP(3),
  ADD COLUMN     "lastEnrichmentAttemptAt" TIMESTAMP(3),
  ADD COLUMN     "enrichmentAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Lead_organizationId_enrichmentTier_idx" ON "Lead"("organizationId", "enrichmentTier");

-- CreateIndex
CREATE INDEX "Lead_organizationId_enrichmentScore_idx" ON "Lead"("organizationId", "enrichmentScore");

-- CreateIndex
CREATE INDEX "Lead_organizationId_enrichmentVersion_idx" ON "Lead"("organizationId", "enrichmentVersion");

-- Backfill: score every existing lead so the categorization is meaningful the
-- moment this ships (otherwise every historical lead reads as NONE until it is
-- next written). This mirrors scoreLead() in
-- backend/src/services/lead-enrichment.service.ts — that function stays the
-- authoritative implementation, and POST /api/leads/enrichment/recompute can
-- rebuild these columns at any time.
WITH agg AS (
  SELECT
    l."id" AS lead_id,
    COUNT(c."id") AS contact_count,
    COUNT(DISTINCT lower(btrim(c."email"))) FILTER (
      WHERE c."email" IS NOT NULL AND btrim(c."email") <> '' AND c."optedOut" = false
        AND (c."emailStatus" IS NULL OR lower(c."emailStatus") NOT IN ('bounced', 'complained', 'undeliverable'))
    ) AS email_count,
    COUNT(*) FILTER (
      WHERE c."phone" IS NOT NULL AND btrim(c."phone") <> '' AND c."optedOut" = false
    ) AS direct_phone_count,
    COALESCE(BOOL_OR(
      c."optedOut" = false AND c."email" IS NOT NULL AND btrim(c."email") <> ''
        AND c."emailVerifiedAt" IS NOT NULL
    ), false) AS has_verified_email,
    COALESCE(BOOL_OR(
      c."optedOut" = false AND btrim(c."firstName") <> '' AND c."lastName" IS NOT NULL AND btrim(c."lastName") <> ''
    ), false) AS has_named_contact,
    COALESCE(BOOL_OR(
      c."optedOut" = false AND c."title" IS NOT NULL
        AND c."title" ~* '(owner|founder|president|chief|c[eofmt]o|principal|partner|director|manager|head of|\mvp\M|vice president)'
    ), false) AS has_decision_maker,
    COALESCE(BOOL_OR(
      c."optedOut" = false AND c."socials" IS NOT NULL AND c."socials"::text NOT IN ('{}', 'null')
    ), false) AS contact_has_social
  FROM "Lead" l
  LEFT JOIN "Contact" c ON c."leadId" = l."id"
  GROUP BY l."id"
),
signals AS (
  SELECT
    a.lead_id,
    a.contact_count,
    a.email_count,
    a.direct_phone_count + (CASE WHEN l."phone" IS NOT NULL AND btrim(l."phone") <> '' THEN 1 ELSE 0 END) AS phone_count,
    (l."website" IS NOT NULL AND btrim(l."website") <> '') OR (l."domain" IS NOT NULL AND btrim(l."domain") <> '') AS has_website,
    (l."city" IS NOT NULL AND btrim(l."city") <> '')
      OR (l."state" IS NOT NULL AND btrim(l."state") <> '')
      OR (l."address" IS NOT NULL AND btrim(l."address") <> '') AS has_location,
    (l."phone" IS NOT NULL AND btrim(l."phone") <> '') AS has_company_phone,
    a.has_named_contact,
    a.has_decision_maker,
    a.email_count >= 1 AS has_email,
    a.email_count >= 2 AS has_multiple_emails,
    a.has_verified_email,
    a.direct_phone_count >= 1 AS has_direct_phone,
    (l."socials" IS NOT NULL AND l."socials"::text NOT IN ('{}', 'null')) OR a.contact_has_social AS has_social
  FROM agg a
  JOIN "Lead" l ON l."id" = a.lead_id
),
scored AS (
  SELECT
    s.*,
    (CASE WHEN s.has_email THEN 25 ELSE 0 END
      + CASE WHEN s.has_named_contact THEN 12 ELSE 0 END
      + CASE WHEN s.has_decision_maker THEN 10 ELSE 0 END
      + CASE WHEN s.has_verified_email THEN 10 ELSE 0 END
      + CASE WHEN s.has_direct_phone THEN 10 ELSE 0 END
      + CASE WHEN s.has_website THEN 10 ELSE 0 END
      + CASE WHEN s.has_company_phone THEN 8 ELSE 0 END
      + CASE WHEN s.has_location THEN 5 ELSE 0 END
      + CASE WHEN s.has_social THEN 5 ELSE 0 END
      + CASE WHEN s.has_multiple_emails THEN 5 ELSE 0 END) AS score
  FROM signals s
)
UPDATE "Lead" target
SET
  "contactCount" = scored.contact_count,
  "emailCount" = scored.email_count,
  "phoneCount" = scored.phone_count,
  "enrichmentScore" = scored.score,
  "enrichmentTier" = (
    CASE
      WHEN NOT (scored.has_email OR scored.has_company_phone OR scored.has_direct_phone OR scored.has_social) THEN 'NONE'
      WHEN NOT scored.has_named_contact AND NOT scored.has_email THEN 'MINIMAL'
      WHEN scored.score >= 80 THEN 'RICH'
      WHEN scored.score >= 60 THEN 'GOOD'
      WHEN scored.score >= 35 THEN 'PARTIAL'
      ELSE 'MINIMAL'
    END
  )::"EnrichmentTier",
  "enrichmentGaps" = to_jsonb(array_remove(ARRAY[
    CASE WHEN NOT scored.has_email THEN 'email'::text END,
    CASE WHEN NOT scored.has_named_contact THEN 'named_contact'::text END,
    CASE WHEN NOT scored.has_decision_maker THEN 'decision_maker'::text END,
    CASE WHEN NOT scored.has_verified_email THEN 'verified_email'::text END,
    CASE WHEN NOT scored.has_direct_phone THEN 'direct_phone'::text END,
    CASE WHEN NOT scored.has_website THEN 'website'::text END,
    CASE WHEN NOT scored.has_company_phone THEN 'company_phone'::text END,
    CASE WHEN NOT scored.has_location THEN 'location'::text END,
    CASE WHEN NOT scored.has_social THEN 'social'::text END
  ], NULL))
FROM scored
WHERE target."id" = scored.lead_id;
