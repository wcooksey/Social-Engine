-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'X');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'ERROR');

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "encryptedState" TEXT NOT NULL,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastValidatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccount_organizationId_idx" ON "SocialAccount"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_organizationId_platform_label_key" ON "SocialAccount"("organizationId", "platform", "label");

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
