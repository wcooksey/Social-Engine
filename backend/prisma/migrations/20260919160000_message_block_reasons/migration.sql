ALTER TABLE "Message" ADD COLUMN "blockedReason" TEXT;
ALTER TABLE "Message" ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT false;
