-- Some dated JP notices use an explicit index.html canonical URL.
-- Preserve the complete URL and the existing origin, path and length restrictions.
ALTER TABLE "BannerSourceIdentity"
  DROP CONSTRAINT "BannerSourceIdentity_url_check",
  ADD CONSTRAINT "BannerSourceIdentity_url_check" CHECK (
    length("sourceUrl") <= length('https://news.fate-go.jp') + 240 AND
    "sourceUrl" ~ '^https://news[.]fate-go[.]jp/20[0-9]{2}/((0[1-9]|1[0-2])/)?[A-Za-z0-9_-]+/(index[.]html)?$'
  );
