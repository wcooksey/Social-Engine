-- AlterTable
-- Line of business a scheduled job belongs to, inherited from the run that
-- created it. Concurrency is capped per playbook as well as per org, so a deep
-- queue for one line of business no longer holds up another. Existing jobs stay
-- NULL and share a single "unfiled" bucket, which is exactly how they behaved
-- before this column existed.
ALTER TABLE "AgentJob" ADD COLUMN     "playbookId" TEXT;

-- CreateIndex
CREATE INDEX "AgentJob_playbookId_status_idx" ON "AgentJob"("playbookId", "status");

-- AddForeignKey
-- SetNull: deleting a playbook must not delete queued work, only unfile it.
ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "Playbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
