-- CreateEnum
-- What an Autopilot goal counts toward its target. Existing goals keep the old
-- behaviour (raw group size) via the LEAD_COUNT default.
CREATE TYPE "AutopilotMetric" AS ENUM ('LEAD_COUNT', 'ENRICHED_LEADS', 'LEADS_WITH_EMAIL');

-- AlterTable
ALTER TABLE "AutopilotGoal"
  ADD COLUMN     "targetMetric" "AutopilotMetric" NOT NULL DEFAULT 'LEAD_COUNT';
