CREATE TABLE "EventGlobalBaseline" (
  "eventId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "baselineHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "startsAtPrecision" "ScheduleTimePrecision" NOT NULL,
  "endsAt" TIMESTAMP(3),
  "endsAtPrecision" "ScheduleTimePrecision",
  "sourceUrl" TEXT NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventGlobalBaseline_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "EventGlobalBaseline_values_check" CHECK (
    "baselineHash" ~ '^[a-f0-9]{64}$' AND length("name") > 0 AND
    length("sourceUrl") BETWEEN 1 AND 2048 AND "sourceUrl" ~ '^https://' AND
    ("endsAt" IS NULL) = ("endsAtPrecision" IS NULL) AND
    ("endsAt" IS NULL OR "endsAt" >= "startsAt")
  )
);
CREATE TABLE "RewardGlobalBaseline" (
  "rewardId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "itemType" "RewardItemType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "expectedAt" TIMESTAMP(3),
  "eventStartsAt" TIMESTAMP(3) NOT NULL,
  "nature" "RewardNature" NOT NULL,
  "eligibility" TEXT,
  "defaultIncluded" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RewardGlobalBaseline_pkey" PRIMARY KEY ("rewardId"),
  CONSTRAINT "RewardGlobalBaseline_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX "EventGlobalBaseline_candidateId_idx" ON "EventGlobalBaseline"("candidateId");
CREATE INDEX "EventGlobalBaseline_startsAt_idx" ON "EventGlobalBaseline"("startsAt");
CREATE INDEX "RewardGlobalBaseline_eventId_idx" ON "RewardGlobalBaseline"("eventId");
CREATE INDEX "RewardGlobalBaseline_candidateId_idx" ON "RewardGlobalBaseline"("candidateId");
CREATE INDEX "RewardGlobalBaseline_expectedAt_idx" ON "RewardGlobalBaseline"("expectedAt");
ALTER TABLE "EventGlobalBaseline" ADD CONSTRAINT "EventGlobalBaseline_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventGlobalBaseline" ADD CONSTRAINT "EventGlobalBaseline_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "GlobalEventCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardGlobalBaseline" ADD CONSTRAINT "RewardGlobalBaseline_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "RewardDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardGlobalBaseline" ADD CONSTRAINT "RewardGlobalBaseline_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardGlobalBaseline" ADD CONSTRAINT "RewardGlobalBaseline_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "GlobalEventCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventGlobalBaseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventGlobalBaseline" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RewardGlobalBaseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RewardGlobalBaseline" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "EventGlobalBaseline", "RewardGlobalBaseline" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "EventGlobalBaseline", "RewardGlobalBaseline" FROM %I', api_role);
  END LOOP;
END $$;
