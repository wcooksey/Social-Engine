ALTER TABLE "EngineChat" ADD COLUMN "groupId" TEXT;
ALTER TABLE "EngineChat" ADD CONSTRAINT "EngineChat_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EngineChat_organizationId_groupId_idx" ON "EngineChat"("organizationId", "groupId");
UPDATE "EngineChat" c SET "groupId" = p."groupId" FROM "Playbook" p WHERE c."playbookId" = p.id AND p.scope = 'GROUP' AND c."organizationId" = p."organizationId";
ALTER TABLE "AgentRun" ADD COLUMN "groupId" TEXT;
CREATE INDEX "AgentRun_organizationId_groupId_idx" ON "AgentRun"("organizationId", "groupId");
ALTER TABLE "Message" ADD COLUMN "provenance" JSONB;
