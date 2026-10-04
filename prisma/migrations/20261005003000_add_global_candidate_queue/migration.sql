CREATE TABLE "GlobalEventCandidate" (
    "id" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "assessmentHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "targetEventId" TEXT,
    "reasons" TEXT[] NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GlobalEventCandidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GlobalEventCandidate_metadata_check" CHECK (
      "sourceKind" IN ('GLOBAL_GAME_DATA', 'PUBLISHER_ANNOUNCEMENT') AND
      length("sourceRecordId") BETWEEN 1 AND 200 AND
      length("sourceUrl") BETWEEN 1 AND 2048 AND "sourceUrl" ~ '^https://' AND
      "contentHash" ~ '^sha256:[a-f0-9]{64}$' AND "assessmentHash" ~ '^[a-f0-9]{64}$' AND
      jsonb_typeof("snapshot") = 'object' AND octet_length("snapshot"::TEXT) <= 65536 AND
      array_position("reasons", NULL) IS NULL AND
      ("targetEventId" IS NULL OR cardinality("reasons") = 0)
    )
);
CREATE UNIQUE INDEX "GlobalEventCandidate_source_assessment_key" ON "GlobalEventCandidate"("sourceKind", "sourceRecordId", "contentHash", "assessmentHash");
CREATE INDEX "GlobalEventCandidate_createdAt_id_idx" ON "GlobalEventCandidate"("createdAt", "id");
CREATE INDEX "GlobalEventCandidate_startsAt_id_idx" ON "GlobalEventCandidate"("startsAt", "id");
CREATE INDEX "GlobalEventCandidate_targetEventId_createdAt_idx" ON "GlobalEventCandidate"("targetEventId", "createdAt");
ALTER TABLE "GlobalEventCandidate" ADD CONSTRAINT "GlobalEventCandidate_targetEventId_fkey" FOREIGN KEY ("targetEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GlobalEventCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GlobalEventCandidate" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "GlobalEventCandidate" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "GlobalEventCandidate" FROM %I', api_role);
  END LOOP;
END $$;
