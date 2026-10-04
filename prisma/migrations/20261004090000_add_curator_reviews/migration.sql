CREATE TABLE "EventReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "effectiveHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventReview_hash_check" CHECK (
      "sourceHash" ~ '^[a-f0-9]{64}$' AND "effectiveHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE "RewardReview" (
    "id" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "effectiveHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RewardReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RewardReview_hash_check" CHECK (
      "sourceHash" ~ '^[a-f0-9]{64}$' AND "effectiveHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE INDEX "EventReview_eventId_createdAt_id_idx" ON "EventReview"("eventId", "createdAt", "id");
CREATE INDEX "RewardReview_rewardId_createdAt_id_idx" ON "RewardReview"("rewardId", "createdAt", "id");
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RewardReview" ADD CONSTRAINT "RewardReview_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "RewardDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EventReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventReview" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RewardReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RewardReview" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "EventReview", "RewardReview" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "EventReview", "RewardReview" FROM %I', api_role);
  END LOOP;
END $$;
