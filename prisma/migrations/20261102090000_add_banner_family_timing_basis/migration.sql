-- Nullable: existing reviews must be explicitly enriched before automatic following.
ALTER TABLE "BannerSourcePublication"
  ADD COLUMN "sourceStartsAt" TIMESTAMP(3),
  ADD COLUMN "sourceEndsAt" TIMESTAMP(3),
  ADD COLUMN "appliedAnchorStartsAt" TIMESTAMP(3),
  ADD CONSTRAINT "BannerSourcePublication_source_window_check" CHECK (
    "sourceEndsAt" IS NULL OR ("sourceStartsAt" IS NOT NULL AND "sourceEndsAt" > "sourceStartsAt")
  ),
  ADD CONSTRAINT "BannerSourcePublication_applied_anchor_check" CHECK (
    "appliedAnchorStartsAt" IS NULL OR "sourceStartsAt" IS NOT NULL
  );

ALTER TABLE "BannerFamilyTimingAnchor"
  ADD COLUMN "referenceStartsAt" TIMESTAMP(3),
  ADD COLUMN "sourceFactsHash" TEXT,
  ADD CONSTRAINT "BannerFamilyTimingAnchor_source_reference_check" CHECK (
    "referenceStartsAt" IS NULL OR "sourceFactsHash" IS NOT NULL
  ),
  ADD CONSTRAINT "BannerFamilyTimingAnchor_source_hash_check" CHECK (
    "sourceFactsHash" IS NULL OR "sourceFactsHash" ~ '^[0-9a-f]{64}$'
  );
