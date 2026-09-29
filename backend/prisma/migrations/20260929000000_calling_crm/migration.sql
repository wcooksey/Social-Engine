-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'CALLER';

-- CreateTable
CREATE TABLE "CrmGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "canExport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmInvite" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "canExport" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmRecord" (
    "leadId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "lastCalledAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmRecord_pkey" PRIMARY KEY ("leadId")
);

-- CreateTable
CREATE TABLE "CrmEvent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT,
    "authorName" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT,
    "note" TEXT NOT NULL,
    "stage" TEXT,
    "followUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmGrant_groupId_idx" ON "CrmGrant"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmGrant_userId_groupId_key" ON "CrmGrant"("userId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmInvite_tokenHash_key" ON "CrmInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "CrmInvite_groupId_idx" ON "CrmInvite"("groupId");

-- CreateIndex
CREATE INDEX "CrmEvent_leadId_createdAt_idx" ON "CrmEvent"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEvent_userId_requestId_key" ON "CrmEvent"("userId", "requestId");

-- AddForeignKey
ALTER TABLE "CrmGrant" ADD CONSTRAINT "CrmGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmGrant" ADD CONSTRAINT "CrmGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmInvite" ADD CONSTRAINT "CrmInvite_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmRecord" ADD CONSTRAINT "CrmRecord_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
