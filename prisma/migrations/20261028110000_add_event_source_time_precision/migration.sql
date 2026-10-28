-- Existing source timestamps do not establish whether a clock was supplied.
-- Leave legacy precision unknown until an importer rereads its source.
ALTER TABLE "Event"
  ADD COLUMN "sourceStartsAtPrecision" "ScheduleTimePrecision",
  ADD COLUMN "sourceEndsAtPrecision" "ScheduleTimePrecision",
  ADD CONSTRAINT "Event_source_start_precision_check" CHECK (
    "sourceStartsAtPrecision" IS NULL OR "sourceStartsAt" IS NOT NULL
  ),
  ADD CONSTRAINT "Event_source_end_precision_check" CHECK (
    "sourceEndsAtPrecision" IS NULL OR "sourceEndsAt" IS NOT NULL
  );
