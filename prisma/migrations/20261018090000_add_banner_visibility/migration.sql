-- Curator visibility is independent of imported banner data and saved plans.
ALTER TABLE "public"."Banner" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
