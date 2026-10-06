-- CreateTable
CREATE TABLE "EventDateOverlay" (
    "eventId" TEXT NOT NULL,
    "anchorEventId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "startsAtPrecision" "ScheduleTimePrecision" NOT NULL,
    "endsAtPrecision" "ScheduleTimePrecision",
    "startStatus" "ScheduleStatus" NOT NULL,
    "endStatus" "ScheduleStatus",
    "curationRevision" INTEGER NOT NULL DEFAULT 0,
    "curationStartsAt" TIMESTAMP(3),
    "curationEndsAt" TIMESTAMP(3),
    "curationStartPrecision" "ScheduleTimePrecision",
    "curationEndPrecision" "ScheduleTimePrecision",
    "sourceUrl" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventDateOverlay_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "BannerDateOverlay" (
    "bannerId" TEXT NOT NULL,
    "anchorEventId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "startsAtPrecision" "ScheduleTimePrecision" NOT NULL,
    "endsAtPrecision" "ScheduleTimePrecision",
    "startStatus" "ScheduleStatus" NOT NULL,
    "endStatus" "ScheduleStatus",
    "sourceUrl" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BannerDateOverlay_pkey" PRIMARY KEY ("bannerId")
);

-- CreateTable
CREATE TABLE "RewardDateOverlay" (
    "rewardId" TEXT NOT NULL,
    "anchorEventId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardDateOverlay_pkey" PRIMARY KEY ("rewardId")
);

-- CreateIndex
CREATE INDEX "EventDateOverlay_anchorEventId_idx" ON "EventDateOverlay"("anchorEventId");

-- CreateIndex
CREATE INDEX "EventDateOverlay_candidateId_idx" ON "EventDateOverlay"("candidateId");

-- CreateIndex
CREATE INDEX "EventDateOverlay_startsAt_idx" ON "EventDateOverlay"("startsAt");

-- CreateIndex
CREATE INDEX "BannerDateOverlay_anchorEventId_idx" ON "BannerDateOverlay"("anchorEventId");

-- CreateIndex
CREATE INDEX "BannerDateOverlay_candidateId_idx" ON "BannerDateOverlay"("candidateId");

-- CreateIndex
CREATE INDEX "BannerDateOverlay_startsAt_idx" ON "BannerDateOverlay"("startsAt");

-- CreateIndex
CREATE INDEX "RewardDateOverlay_anchorEventId_idx" ON "RewardDateOverlay"("anchorEventId");

-- CreateIndex
CREATE INDEX "RewardDateOverlay_candidateId_idx" ON "RewardDateOverlay"("candidateId");

-- CreateIndex
CREATE INDEX "RewardDateOverlay_expectedAt_idx" ON "RewardDateOverlay"("expectedAt");

-- AddForeignKey
ALTER TABLE "EventDateOverlay" ADD CONSTRAINT "EventDateOverlay_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDateOverlay" ADD CONSTRAINT "EventDateOverlay_anchorEventId_fkey" FOREIGN KEY ("anchorEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDateOverlay" ADD CONSTRAINT "EventDateOverlay_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "GlobalEventCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerDateOverlay" ADD CONSTRAINT "BannerDateOverlay_bannerId_fkey" FOREIGN KEY ("bannerId") REFERENCES "Banner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerDateOverlay" ADD CONSTRAINT "BannerDateOverlay_anchorEventId_fkey" FOREIGN KEY ("anchorEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerDateOverlay" ADD CONSTRAINT "BannerDateOverlay_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "GlobalEventCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardDateOverlay" ADD CONSTRAINT "RewardDateOverlay_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "RewardDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardDateOverlay" ADD CONSTRAINT "RewardDateOverlay_anchorEventId_fkey" FOREIGN KEY ("anchorEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardDateOverlay" ADD CONSTRAINT "RewardDateOverlay_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "GlobalEventCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventDateOverlay" ADD CONSTRAINT "EventDateOverlay_valid_range" CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "BannerDateOverlay" ADD CONSTRAINT "BannerDateOverlay_valid_range" CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "EventDateOverlay" ADD CONSTRAINT "EventDateOverlay_end_fields" CHECK (("endsAt" IS NULL) = ("endsAtPrecision" IS NULL) AND ("endsAt" IS NULL) = ("endStatus" IS NULL));
ALTER TABLE "BannerDateOverlay" ADD CONSTRAINT "BannerDateOverlay_end_fields" CHECK (("endsAt" IS NULL) = ("endsAtPrecision" IS NULL) AND ("endsAt" IS NULL) = ("endStatus" IS NULL));
ALTER TABLE "EventDateOverlay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BannerDateOverlay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RewardDateOverlay" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "EventDateOverlay", "BannerDateOverlay", "RewardDateOverlay" FROM PUBLIC, anon, authenticated;
