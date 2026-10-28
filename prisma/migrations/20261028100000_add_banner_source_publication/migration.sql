-- The composite key prevents a publication from using another banner's binding.
CREATE UNIQUE INDEX "BannerSourceIdentity_bannerId_sourceKey_key"
  ON "BannerSourceIdentity"("bannerId", "sourceKey");
DROP INDEX "BannerSourceIdentity_bannerId_idx";

CREATE TABLE "BannerSourcePublication" (
  "bannerId" TEXT NOT NULL PRIMARY KEY,
  "sourceKey" TEXT NOT NULL,
  "ownedFields" TEXT[] NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "articleContentHash" TEXT NOT NULL,
  "periodEvidenceHash" TEXT NOT NULL,
  "publishedContentHash" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BannerSourcePublication_bannerId_fkey" FOREIGN KEY ("bannerId")
    REFERENCES "Banner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BannerSourcePublication_identity_fkey" FOREIGN KEY ("bannerId", "sourceKey")
    REFERENCES "BannerSourceIdentity"("bannerId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BannerSourcePublication_revision_check" CHECK ("revision" > 0),
  -- Timing and roster ownership require evidence gates not supplied by today's extractor.
  CONSTRAINT "BannerSourcePublication_fields_check" CHECK (
    cardinality("ownedFields") BETWEEN 1 AND 2 AND
    "ownedFields" <@ ARRAY['NAME', 'SOURCE']::TEXT[] AND
    array_position("ownedFields", NULL) IS NULL AND
    (cardinality("ownedFields") = 1 OR "ownedFields"[1] <> "ownedFields"[2])
  ),
  CONSTRAINT "BannerSourcePublication_hashes_check" CHECK (
    "articleContentHash" ~ '^[a-f0-9]{64}$' AND
    "periodEvidenceHash" ~ '^[a-f0-9]{64}$' AND
    "publishedContentHash" ~ '^[a-f0-9]{64}$'
  )
);
ALTER TABLE "BannerSourcePublication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BannerSourcePublication" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "BannerSourcePublication" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "BannerSourcePublication" FROM %I', api_role);
  END LOOP;
END $$;
