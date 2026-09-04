-- CreateEnum
CREATE TYPE "EmailTransport" AS ENUM ('MAILGUN', 'GMAIL');

-- CreateEnum
CREATE TYPE "GmailAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'PAUSED', 'ERROR');

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "GmailAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT,
    "dailySendCap" INTEGER NOT NULL DEFAULT 40,
    "minSpacingSeconds" INTEGER NOT NULL DEFAULT 120,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "sentDate" DATE,
    "lastSendAt" TIMESTAMP(3),
    "lastHistoryId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_emailAddress_key" ON "GmailAccount"("emailAddress");

-- CreateIndex
CREATE INDEX "GmailAccount_organizationId_status_idx" ON "GmailAccount"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalThreadId" TEXT,
ADD COLUMN     "gmailAccountId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_gmailAccountId_idx" ON "Conversation"("gmailAccountId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "gmailAccountId" TEXT,
ADD COLUMN     "headerMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Message_gmailAccountId_idx" ON "Message"("gmailAccountId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Playbook" ADD COLUMN     "emailTransport" "EmailTransport" NOT NULL DEFAULT 'MAILGUN',
ADD COLUMN     "gmailAccountId" TEXT;

-- CreateIndex
CREATE INDEX "Playbook_gmailAccountId_idx" ON "Playbook"("gmailAccountId");

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_gmailAccountId_fkey" FOREIGN KEY ("gmailAccountId") REFERENCES "GmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
