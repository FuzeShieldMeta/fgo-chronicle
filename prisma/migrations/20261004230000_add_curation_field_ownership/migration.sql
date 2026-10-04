-- Existing full-snapshot corrections retain ownership of every field.
ALTER TABLE "EventCuration" ADD COLUMN "ownedFields" TEXT[] NOT NULL
  DEFAULT ARRAY['name', 'startsAt', 'endsAt', 'hidden', 'shiftRewardDates']::TEXT[];
ALTER TABLE "RewardCuration" ADD COLUMN "ownedFields" TEXT[] NOT NULL
  DEFAULT ARRAY['itemType', 'amount', 'expectedAt', 'nature', 'eligibility', 'defaultIncluded']::TEXT[];

ALTER TABLE "EventCuration" ADD CONSTRAINT "EventCuration_ownedFields_allowed"
  CHECK ("ownedFields" <@ ARRAY['name', 'startsAt', 'endsAt', 'hidden', 'shiftRewardDates']::TEXT[]
    AND array_position("ownedFields", NULL) IS NULL);
ALTER TABLE "RewardCuration" ADD CONSTRAINT "RewardCuration_ownedFields_allowed"
  CHECK ("ownedFields" <@ ARRAY['itemType', 'amount', 'expectedAt', 'nature', 'eligibility', 'defaultIncluded']::TEXT[]
    AND array_position("ownedFields", NULL) IS NULL);

-- These existing curator-only tables keep their forced RLS and revoked grants.
