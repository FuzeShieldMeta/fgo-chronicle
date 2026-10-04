CREATE TABLE "EventDateEvidence" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceRegion" TEXT NOT NULL DEFAULT 'NA',
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "confirmedStartsAt" TIMESTAMP(3),
    "confirmedStartPrecision" "ScheduleTimePrecision",
    "confirmedEndsAt" TIMESTAMP(3),
    "confirmedEndPrecision" "ScheduleTimePrecision",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventDateEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventDateEvidence_source_check" CHECK (
      "sourceKind" IN ('GLOBAL_GAME_DATA', 'PUBLISHER_ANNOUNCEMENT') AND
      "sourceRegion" = 'NA' AND
      length("sourceRecordId") BETWEEN 1 AND 200 AND
      length("sourceUrl") BETWEEN 1 AND 2048 AND
      "sourceUrl" ~ '^https://' AND
      "contentHash" ~ '^sha256:[a-f0-9]{64}$'
    ),
    CONSTRAINT "EventDateEvidence_boundary_check" CHECK (
      ("confirmedStartsAt" IS NOT NULL OR "confirmedEndsAt" IS NOT NULL) AND
      (("confirmedStartsAt" IS NULL) = ("confirmedStartPrecision" IS NULL)) AND
      (("confirmedEndsAt" IS NULL) = ("confirmedEndPrecision" IS NULL)) AND
      ("confirmedEndsAt" IS NULL OR "confirmedStartsAt" IS NULL OR "confirmedEndsAt" >= "confirmedStartsAt")
    )
);
CREATE INDEX "EventDateEvidence_eventId_createdAt_id_idx" ON "EventDateEvidence"("eventId", "createdAt", "id");
ALTER TABLE "EventDateEvidence" ADD CONSTRAINT "EventDateEvidence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventDateEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventDateEvidence" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "EventDateEvidence" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "EventDateEvidence" FROM %I', api_role);
  END LOOP;
END $$;
