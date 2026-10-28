CREATE TABLE "BannerFamilyTimingAnchor" (
  "familyId" TEXT NOT NULL PRIMARY KEY,
  "anchorEventId" TEXT NOT NULL,
  "jpResetDay" DATE NOT NULL,
  "naResetDay" DATE NOT NULL,
  "factsHash" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "sourceContentHash" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BannerFamilyTimingAnchor_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "EventFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BannerFamilyTimingAnchor_anchorEventId_fkey" FOREIGN KEY ("anchorEventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BannerFamilyTimingAnchor_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "BannerFamilyTimingAnchor_facts_check" CHECK ("factsHash" ~ '^[a-f0-9]{64}$' AND length("sourceUrl") > 0),
  CONSTRAINT "BannerFamilyTimingAnchor_days_check" CHECK (
    "jpResetDay" BETWEEN DATE '2000-01-01' AND DATE '2099-12-31' AND
    "naResetDay" BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
  )
);
CREATE INDEX "BannerFamilyTimingAnchor_anchorEventId_idx" ON "BannerFamilyTimingAnchor"("anchorEventId");
ALTER TABLE "BannerFamilyTimingAnchor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BannerFamilyTimingAnchor" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "BannerFamilyTimingAnchor" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "BannerFamilyTimingAnchor" FROM %I', api_role);
  END LOOP;
END $$;

ALTER TABLE "BannerSourcePublication"
  ADD COLUMN "timingAnchorFamilyId" TEXT,
  ADD COLUMN "timingAnchorRevision" INTEGER,
  ADD CONSTRAINT "BannerSourcePublication_timingAnchorFamilyId_fkey" FOREIGN KEY ("timingAnchorFamilyId") REFERENCES "BannerFamilyTimingAnchor"("familyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BannerSourcePublication" DROP CONSTRAINT "BannerSourcePublication_fields_check";
CREATE INDEX "BannerSourcePublication_timingAnchorFamilyId_idx" ON "BannerSourcePublication"("timingAnchorFamilyId");
ALTER TABLE "BannerSourcePublication" ADD CONSTRAINT "BannerSourcePublication_fields_check" CHECK (
  cardinality("ownedFields") BETWEEN 1 AND 3 AND
  "ownedFields" <@ ARRAY['NAME', 'SOURCE', 'TIMING']::TEXT[] AND
  array_position("ownedFields", NULL) IS NULL AND
  array_length(array_positions("ownedFields", 'NAME'), 1) IS NOT DISTINCT FROM CASE WHEN 'NAME'=ANY("ownedFields") THEN 1 ELSE NULL END AND
  array_length(array_positions("ownedFields", 'SOURCE'), 1) IS NOT DISTINCT FROM CASE WHEN 'SOURCE'=ANY("ownedFields") THEN 1 ELSE NULL END AND
  array_length(array_positions("ownedFields", 'TIMING'), 1) IS NOT DISTINCT FROM CASE WHEN 'TIMING'=ANY("ownedFields") THEN 1 ELSE NULL END
);
ALTER TABLE "BannerSourcePublication" ADD CONSTRAINT "BannerSourcePublication_timing_check" CHECK (
  CASE WHEN 'TIMING'=ANY("ownedFields")
    THEN "timingAnchorFamilyId" IS NOT NULL AND "timingAnchorRevision" IS NOT NULL AND "timingAnchorRevision" > 0
    ELSE "timingAnchorFamilyId" IS NULL AND "timingAnchorRevision" IS NULL END
);
