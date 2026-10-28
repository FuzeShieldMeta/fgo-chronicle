CREATE TABLE "BannerSourceIdentity" (
  "sourceKey" TEXT NOT NULL,
  "bannerId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "articleContentHash" TEXT NOT NULL,
  "periodEvidenceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BannerSourceIdentity_pkey" PRIMARY KEY ("sourceKey"),
  CONSTRAINT "BannerSourceIdentity_key_check" CHECK (
    length("sourceKey") <= 500 AND "sourceKey" ~ '^publisher:JP:pickup:[a-z0-9][a-z0-9_-]*$'
  ),
  CONSTRAINT "BannerSourceIdentity_article_hash_check" CHECK ("articleContentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BannerSourceIdentity_period_hash_check" CHECK ("periodEvidenceHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BannerSourceIdentity_url_check" CHECK (
    length("sourceUrl") <= 500 AND "sourceUrl" ~ '^https://news[.]fate-go[.]jp/[0-9]{4}/[A-Za-z0-9_-]+/$'
  ),
  CONSTRAINT "BannerSourceIdentity_bannerId_fkey" FOREIGN KEY ("bannerId")
    REFERENCES "Banner"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "BannerSourceIdentity_bannerId_idx" ON "BannerSourceIdentity"("bannerId");
ALTER TABLE "BannerSourceIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BannerSourceIdentity" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "BannerSourceIdentity" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "BannerSourceIdentity" FROM %I', api_role);
  END LOOP;
END $$;
