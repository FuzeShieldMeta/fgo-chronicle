UPDATE "Event"
SET
  "startsAtPrecision" = 'DATE_ONLY',
  "endsAtPrecision" = CASE
    WHEN "endsAt" IS NULL THEN NULL
    ELSE 'DATE_ONLY'::"ScheduleTimePrecision"
  END
WHERE
  "status" = 'PROJECTED'
  AND "projectionMethod" = 'TWO_CALENDAR_YEARS';
