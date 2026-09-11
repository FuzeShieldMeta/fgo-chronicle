-- AlterTable
ALTER TABLE "Servant" ADD COLUMN "rarity" INTEGER;

-- AddConstraint
ALTER TABLE "Servant"
ADD CONSTRAINT "Servant_valid_rarity" CHECK ("rarity" IS NULL OR "rarity" BETWEEN 0 AND 5);

-- CreateTable
CREATE TABLE "SummonLineup" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "bannerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "evidenceUrl" TEXT NOT NULL,
    "sourceRegion" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SummonLineup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SummonLineupServant" (
    "lineupId" TEXT NOT NULL,
    "servantId" INTEGER NOT NULL,
    "soloRateUp" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SummonLineupServant_pkey" PRIMARY KEY ("lineupId", "servantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SummonLineup_sourceKey_key" ON "SummonLineup"("sourceKey");
CREATE INDEX "SummonLineup_bannerId_startsAt_idx" ON "SummonLineup"("bannerId", "startsAt");
CREATE INDEX "SummonLineup_startsAt_endsAt_idx" ON "SummonLineup"("startsAt", "endsAt");
CREATE INDEX "SummonLineupServant_servantId_idx" ON "SummonLineupServant"("servantId");

-- AddForeignKey
ALTER TABLE "SummonLineup" ADD CONSTRAINT "SummonLineup_bannerId_fkey" FOREIGN KEY ("bannerId") REFERENCES "Banner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SummonLineupServant" ADD CONSTRAINT "SummonLineupServant_lineupId_fkey" FOREIGN KEY ("lineupId") REFERENCES "SummonLineup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SummonLineupServant" ADD CONSTRAINT "SummonLineupServant_servantId_fkey" FOREIGN KEY ("servantId") REFERENCES "Servant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
