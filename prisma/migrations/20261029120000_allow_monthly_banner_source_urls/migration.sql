-- Keep the registry aligned with canonical, dated JP notice URLs.
-- One ALTER statement changes the constraint atomically; existing data is validated.
ALTER TABLE "BannerSourceIdentity"
  DROP CONSTRAINT "BannerSourceIdentity_url_check",
  ADD CONSTRAINT "BannerSourceIdentity_url_check" CHECK (
    length("sourceUrl") <= length('https://news.fate-go.jp') + 240 AND
    "sourceUrl" ~ '^https://news[.]fate-go[.]jp/20[0-9]{2}/((0[1-9]|1[0-2])/)?[A-Za-z0-9_-]+/$'
  );
