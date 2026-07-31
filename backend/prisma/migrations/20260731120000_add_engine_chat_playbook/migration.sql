-- AlterTable
ALTER TABLE "EngineChat" ADD COLUMN     "playbookId" TEXT;

-- CreateIndex
CREATE INDEX "EngineChat_playbookId_updatedAt_idx" ON "EngineChat"("playbookId", "updatedAt");

-- AddForeignKey
-- SetNull, not Cascade: deleting a playbook must not delete the conversations
-- that ran under it. The transcript is the record of what was actually done.
ALTER TABLE "EngineChat" ADD CONSTRAINT "EngineChat_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "Playbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
