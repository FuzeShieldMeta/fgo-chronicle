import type { ScheduleTimePrecision } from "~/app/timeline/_lib/schedule-layout";
import { calendarDayKey, calendarDayDistance } from "./schedule-layout";
import type { TimelineSearchEntry } from "~/shared/timeline-search";

export function formatCalendarDay(day: string, locale = "en") {
  return formatScheduleDate(
    new Date(`${day}T00:00:00Z`),
    "DATE_ONLY",
    "UTC",
    undefined,
    locale,
  );
}

export function formatSearchAvailability(
  entry: Pick<
    TimelineSearchEntry,
    "startsAt" | "endsAt" | "startsAtPrecision" | "endsAtPrecision" | "status"
  >,
  now: Date,
  timeZone: string,
) {
  const today = calendarDayKey(now, "EXACT", timeZone);
  const startDay = calendarDayKey(
    entry.startsAt,
    entry.startsAtPrecision,
    timeZone,
  );
  const projected = entry.status === "PROJECTED";
  if (entry.endsAt) {
    const ended =
      entry.endsAtPrecision === "DATE_ONLY"
        ? calendarDayKey(entry.endsAt, "DATE_ONLY", timeZone) < today
        : entry.endsAt.getTime() <= now.getTime();
    if (ended) return projected ? "Projected period ended" : "Ended";
  }
  const upcoming =
    entry.startsAtPrecision === "DATE_ONLY"
      ? startDay > today
      : entry.startsAt.getTime() > now.getTime();
  if (upcoming) {
    const days = calendarDayDistance(today, startDay);
    if (days === 0) return projected ? "Expected today" : "Starts today";
    if (days === 1) return projected ? "Expected tomorrow" : "Starts tomorrow";
    return `${projected ? "Expected" : "Starts"} in ${days.toLocaleString("en")} days`;
  }
  // A missing end date cannot establish that a past campaign is still active.
  if (!entry.endsAt)
    return projected
      ? "Projected start passed · end unknown"
      : "Started · end unknown";
  return projected ? "Expected to be active" : "Active now";
}

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
