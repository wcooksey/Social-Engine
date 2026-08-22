-- CreateEnum
CREATE TYPE "DomainPurpose" AS ENUM ('COLD_OUTREACH', 'TRANSACTIONAL');

-- CreateEnum
CREATE TYPE "EmailDomainStatus" AS ENUM ('PENDING', 'WARMING', 'ACTIVE', 'PAUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('WARMING', 'ACTIVE', 'PAUSED', 'RETIRED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "mailboxId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mailboxId" TEXT;

-- AlterTable
ALTER TABLE "Playbook" ADD COLUMN     "identityPostalAddress" TEXT,
ADD COLUMN     "senderPoolId" TEXT;

-- CreateTable
CREATE TABLE "EmailDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mailgun',
    "purpose" "DomainPurpose" NOT NULL DEFAULT 'COLD_OUTREACH',
    "status" "EmailDomainStatus" NOT NULL DEFAULT 'PENDING',
    "apiKeyEncrypted" TEXT,
    "spfOk" BOOLEAN,
    "dkimOk" BOOLEAN,
    "mxOk" BOOLEAN,
    "trackingOk" BOOLEAN,
    "lastCheckedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "firstSendAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "localPart" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "replyTo" TEXT,
    "status" "MailboxStatus" NOT NULL DEFAULT 'WARMING',
    "warmupStartedAt" TIMESTAMP(3),
    "dailyCapStart" INTEGER NOT NULL DEFAULT 5,
    "dailyCapMax" INTEGER NOT NULL DEFAULT 40,
    "warmupGrowthPct" INTEGER NOT NULL DEFAULT 30,
    "hourlyCap" INTEGER NOT NULL DEFAULT 8,
    "pausedReason" TEXT,
    "pausedUntil" TIMESTAMP(3),
    "lastSendAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxDailyStat" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "bounced" INTEGER NOT NULL DEFAULT 0,
    "complained" INTEGER NOT NULL DEFAULT 0,
    "opened" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MailboxDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderPool" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderPoolMailbox" (
    "poolId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,

    CONSTRAINT "SenderPoolMailbox_pkey" PRIMARY KEY ("poolId","mailboxId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailDomain_domain_key" ON "EmailDomain"("domain");

-- CreateIndex
CREATE INDEX "EmailDomain_organizationId_status_idx" ON "EmailDomain"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_address_key" ON "Mailbox"("address");

-- CreateIndex
CREATE INDEX "Mailbox_organizationId_status_idx" ON "Mailbox"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_domainId_localPart_key" ON "Mailbox"("domainId", "localPart");

-- CreateIndex
CREATE INDEX "MailboxDailyStat_date_idx" ON "MailboxDailyStat"("date");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxDailyStat_mailboxId_date_key" ON "MailboxDailyStat"("mailboxId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SenderPool_organizationId_name_key" ON "SenderPool"("organizationId", "name");

-- CreateIndex
CREATE INDEX "SenderPoolMailbox_mailboxId_idx" ON "SenderPoolMailbox"("mailboxId");

-- CreateIndex
CREATE INDEX "Conversation_mailboxId_idx" ON "Conversation"("mailboxId");

-- CreateIndex
CREATE INDEX "Message_mailboxId_idx" ON "Message"("mailboxId");

-- CreateIndex
CREATE INDEX "Playbook_senderPoolId_idx" ON "Playbook"("senderPoolId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDomain" ADD CONSTRAINT "EmailDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "EmailDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxDailyStat" ADD CONSTRAINT "MailboxDailyStat_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderPool" ADD CONSTRAINT "SenderPool_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderPoolMailbox" ADD CONSTRAINT "SenderPoolMailbox_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "SenderPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderPoolMailbox" ADD CONSTRAINT "SenderPoolMailbox_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_senderPoolId_fkey" FOREIGN KEY ("senderPoolId") REFERENCES "SenderPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

