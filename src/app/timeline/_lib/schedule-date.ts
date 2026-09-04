import type { ScheduleTimePrecision } from "~/app/timeline/_lib/schedule-layout";

export function formatScheduleDate(
  value: Date | null,
  precision: ScheduleTimePrecision | null,
  timeZone: string,
  missingLabel = "End date unknown",
  locale?: string,
) {
  if (!value) return missingLabel;

  if (precision === "DATE_ONLY") {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(value);
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(value);
}
