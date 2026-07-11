-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('COORDINATOR', 'RESEARCHER', 'CALLER', 'SDR');

-- AlterTable
ALTER TABLE "AgentJob" ADD COLUMN     "role" "AgentRole" NOT NULL DEFAULT 'COORDINATOR';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "role" "AgentRole" NOT NULL DEFAULT 'COORDINATOR';
