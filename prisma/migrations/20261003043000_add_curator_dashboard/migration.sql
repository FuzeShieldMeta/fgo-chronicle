-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isCurator" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EventCuration" (
    "eventId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "startsAtPrecision" "ScheduleTimePrecision" NOT NULL,
    "endsAt" TIMESTAMP(3),
    "endsAtPrecision" "ScheduleTimePrecision",
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "shiftRewardDates" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventCuration_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "RewardCuration" (
    "rewardId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "itemType" "RewardItemType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "nature" "RewardNature" NOT NULL,
    "eligibility" TEXT,
    "defaultIncluded" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardCuration_pkey" PRIMARY KEY ("rewardId")
);

-- CreateTable
CREATE TABLE "CuratorChange" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuratorChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventCuration_active_startsAt_idx" ON "EventCuration"("active", "startsAt");

-- CreateIndex
CREATE INDEX "RewardCuration_active_expectedAt_idx" ON "RewardCuration"("active", "expectedAt");

-- CreateIndex
CREATE INDEX "CuratorChange_targetKind_targetId_createdAt_idx" ON "CuratorChange"("targetKind", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "CuratorChange_createdAt_idx" ON "CuratorChange"("createdAt");

-- AddForeignKey
ALTER TABLE "EventCuration" ADD CONSTRAINT "EventCuration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardCuration" ADD CONSTRAINT "RewardCuration_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "RewardDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventCuration" ADD CONSTRAINT "EventCuration_revision_check" CHECK ("revision" > 0);
ALTER TABLE "EventCuration" ADD CONSTRAINT "EventCuration_interval_check" CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "RewardCuration" ADD CONSTRAINT "RewardCuration_revision_check" CHECK ("revision" > 0);
ALTER TABLE "RewardCuration" ADD CONSTRAINT "RewardCuration_amount_check" CHECK ("amount" >= 0);

ALTER TABLE "EventCuration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventCuration" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RewardCuration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RewardCuration" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CuratorChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CuratorChange" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "EventCuration", "RewardCuration", "CuratorChange" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "EventCuration", "RewardCuration", "CuratorChange" FROM %I', api_role);
  END LOOP;
END $$;
