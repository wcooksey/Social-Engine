-- AlterTable
-- Portion of inputTokens served from the provider's prompt cache (a subset of
-- inputTokens, not an addition). Existing rows default to 0, which prices them
-- exactly as they were priced before — the historical figures are unchanged by
-- this migration, they are simply no longer recomputable as anything else.
ALTER TABLE "AgentRun" ADD COLUMN     "cachedInputTokens" INTEGER NOT NULL DEFAULT 0;
