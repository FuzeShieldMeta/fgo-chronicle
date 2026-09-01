-- CreateEnum
CREATE TYPE "ScheduleProjectionMethod" AS ENUM ('TWO_CALENDAR_YEARS');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Event"
ADD COLUMN "sourceStartsAt" TIMESTAMP(3),
ADD COLUMN "sourceEndsAt" TIMESTAMP(3),
ADD COLUMN "projectionMethod" "ScheduleProjectionMethod",
ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN "sourceContentHash" TEXT;

-- AlterTable
ALTER TABLE "RewardDefinition" ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "SyncRunStatus" NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "selectedCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "frozenDifferenceCount" INTEGER NOT NULL DEFAULT 0,
    "rewardCount" INTEGER NOT NULL DEFAULT 0,
    "omittedRewardCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncRun_source_startedAt_idx" ON "SyncRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_status_startedAt_idx" ON "SyncRun"("status", "startedAt");
