-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('MAIN_EVENT', 'PRE_RELEASE_CAMPAIGN', 'LOGIN_BONUS', 'CAMPAIGN', 'EVENT_SHOP', 'QUEST_RELEASE', 'LIMITED_MISSION', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RewardSourceType" AS ENUM ('LOGIN_BONUS', 'PRE_CAMPAIGN', 'EVENT_SHOP', 'POINT_REWARD', 'QUEST_CLEAR', 'CHALLENGE_QUEST', 'LIMITED_MISSION', 'MASTER_MISSION', 'SOCIAL_CAMPAIGN', 'MAINTENANCE', 'LOGIN_MILESTONE', 'OTHER');

-- CreateEnum
CREATE TYPE "RewardItemType" AS ENUM ('SAINT_QUARTZ', 'SAINT_QUARTZ_FRAGMENT', 'SUMMON_TICKET', 'CRYSTALLIZED_LORE', 'HOLY_GRAIL');

-- CreateEnum
CREATE TYPE "RewardNature" AS ENUM ('DETERMINISTIC', 'CONDITIONAL', 'CURATED_ESTIMATE');

-- CreateTable
CREATE TABLE "EventFamily" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "artworkUrl" TEXT,
    "artworkSourceUrl" TEXT,
    "artworkAlt" TEXT,
    "artworkReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "familyId" TEXT,
    "name" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "ScheduleStatus" NOT NULL,
    "sourceUrl" TEXT,
    "sourceRegion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardSource" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "eventId" TEXT,
    "name" TEXT NOT NULL,
    "type" "RewardSourceType" NOT NULL,
    "status" "ScheduleStatus" NOT NULL,
    "evidenceUrl" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardDefinition" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "rewardSourceId" TEXT NOT NULL,
    "itemType" "RewardItemType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "nature" "RewardNature" NOT NULL,
    "eligibility" TEXT,
    "defaultIncluded" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardDefinition_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Banner" ADD COLUMN "familyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EventFamily_sourceKey_key" ON "EventFamily"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "Event_sourceKey_key" ON "Event"("sourceKey");

-- CreateIndex
CREATE INDEX "Event_startsAt_idx" ON "Event"("startsAt");

-- CreateIndex
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_familyId_startsAt_idx" ON "Event"("familyId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardSource_sourceKey_key" ON "RewardSource"("sourceKey");

-- CreateIndex
CREATE INDEX "RewardSource_eventId_idx" ON "RewardSource"("eventId");

-- CreateIndex
CREATE INDEX "RewardSource_type_status_idx" ON "RewardSource"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RewardDefinition_sourceKey_key" ON "RewardDefinition"("sourceKey");

-- CreateIndex
CREATE INDEX "RewardDefinition_rewardSourceId_expectedAt_idx" ON "RewardDefinition"("rewardSourceId", "expectedAt");

-- CreateIndex
CREATE INDEX "RewardDefinition_itemType_expectedAt_idx" ON "RewardDefinition"("itemType", "expectedAt");

-- CreateIndex
CREATE INDEX "Banner_familyId_startsAt_idx" ON "Banner"("familyId", "startsAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "EventFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardSource" ADD CONSTRAINT "RewardSource_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardDefinition" ADD CONSTRAINT "RewardDefinition_rewardSourceId_fkey" FOREIGN KEY ("rewardSourceId") REFERENCES "RewardSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "EventFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;
