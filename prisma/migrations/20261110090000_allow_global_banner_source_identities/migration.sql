ALTER TABLE "BannerSourceIdentity"
  DROP CONSTRAINT "BannerSourceIdentity_key_check",
  DROP CONSTRAINT "BannerSourceIdentity_url_check",
  ADD CONSTRAINT "BannerSourceIdentity_key_check" CHECK (
    length("sourceKey") <= 500 AND
    "sourceKey" ~ '^publisher:(JP|NA):pickup:[a-z0-9][a-z0-9_-]*$'
  ),
  ADD CONSTRAINT "BannerSourceIdentity_url_check" CHECK (
    (
      "sourceKey" LIKE 'publisher:JP:pickup:%' AND
      length("sourceUrl") <= length('https://news.fate-go.jp') + 240 AND
      "sourceUrl" ~ '^https://news[.]fate-go[.]jp/20[0-9]{2}/((0[1-9]|1[0-2])/)?[A-Za-z0-9_-]+/(index[.]html)?$'
    ) OR (
      "sourceKey" LIKE 'publisher:NA:pickup:%' AND
      length("sourceUrl") <= length('https://webview.fate-go.us') + 160 AND
      "sourceUrl" ~ '^https://webview[.]fate-go[.]us/[0-9]{4}/[A-Za-z0-9_-]+/$'
    )
  );

ALTER TABLE "BannerSourcePublication"
  DROP CONSTRAINT "BannerSourcePublication_timing_check",
  ADD CONSTRAINT "BannerSourcePublication_timing_check" CHECK (
    CASE WHEN "sourceKey" LIKE 'publisher:NA:pickup:%' THEN
      "timingAnchorFamilyId" IS NULL AND "timingAnchorRevision" IS NULL AND
      "sourceStartsAt" IS NULL AND "sourceEndsAt" IS NULL AND "appliedAnchorStartsAt" IS NULL AND
      (NOT ('TIMING'=ANY("ownedFields")) OR 'SOURCE'=ANY("ownedFields"))
    WHEN 'TIMING'=ANY("ownedFields") THEN
      "timingAnchorFamilyId" IS NOT NULL AND "timingAnchorRevision" IS NOT NULL AND "timingAnchorRevision" > 0
    ELSE "timingAnchorFamilyId" IS NULL AND "timingAnchorRevision" IS NULL END
  );
