-- CreateEnum
CREATE TYPE "ScheduleTimePrecision" AS ENUM ('DATE_ONLY', 'EXACT');

-- AlterTable
ALTER TABLE "Event"
ADD COLUMN "startsAtPrecision" "ScheduleTimePrecision" NOT NULL DEFAULT 'EXACT',
ADD COLUMN "endsAtPrecision" "ScheduleTimePrecision";

UPDATE "Event"
SET "endsAtPrecision" = 'EXACT'
WHERE "endsAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "Banner"
ADD COLUMN "startsAtPrecision" "ScheduleTimePrecision" NOT NULL DEFAULT 'EXACT',
ADD COLUMN "endsAtPrecision" "ScheduleTimePrecision";

UPDATE "Banner"
SET
  "startsAtPrecision" = 'DATE_ONLY',
  "endsAtPrecision" = CASE
    WHEN "endsAt" IS NULL THEN NULL
    ELSE 'DATE_ONLY'::"ScheduleTimePrecision"
  END;
