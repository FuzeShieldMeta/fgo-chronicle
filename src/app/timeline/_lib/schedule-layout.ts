export const timelineCategories = [
  "EVENT",
  "SUMMONING_CAMPAIGN",
  "INCOME_SOURCE",
] as const;

export type TimelineCategory = (typeof timelineCategories)[number];
export type ScheduleTimePrecision = "DATE_ONLY" | "EXACT";

export type ScheduleInterval = {
  key: string;
  category: TimelineCategory;
  startsAt: Date;
  startsAtPrecision: ScheduleTimePrecision;
  endsAt: Date | null;
  endsAtPrecision: ScheduleTimePrecision | null;
};

export type ScheduleLayoutItem<T extends ScheduleInterval> = T & {
  startDay: string;
  endDay: string;
  startRow: number;
  endRow: number;
  lane: number;
  groupLaneCount: number;
  startsBeforeRange: boolean;
  endsAfterRange: boolean;
};

export type ScheduleCategoryLayout<T extends ScheduleInterval> = {
  category: TimelineCategory;
  laneCount: number;
  items: Array<ScheduleLayoutItem<T>>;
};

type LayoutOptions = {
  startDay: string;
  endDay: string;
  timeZone: string;
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_VISIBLE_LANES = 3;

export function laneSharePercent(laneCount: number) {
  if (!Number.isInteger(laneCount) || laneCount < 0) {
    throw new Error("The timeline lane count must be a non-negative integer.");
  }

  return 100 / Math.max(laneCount, DEFAULT_VISIBLE_LANES);
}

function dayNumber(dayKey: string) {
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new Error(`Invalid calendar day: ${dayKey}`);
  }

  const value = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid calendar day: ${dayKey}`);
  }

  return Math.floor(value / DAY_MS);
}

function dayKeyFromNumber(value: number) {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

export function calendarDayKey(
  value: Date,
  precision: ScheduleTimePrecision,
  timeZone: string,
) {
  if (precision === "DATE_ONLY") {
    return value.toISOString().slice(0, 10);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map(({ type, value: part }) => [type, part]));

  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function calendarDays(startDay: string, endDay: string) {
  const start = dayNumber(startDay);
  const end = dayNumber(endDay);

  if (end < start) {
    throw new Error("The timeline end day must not be before its start day.");
  }

  return Array.from({ length: end - start + 1 }, (_, index) =>
    dayKeyFromNumber(start + index),
  );
}

export function calendarDayDistance(fromDay: string, toDay: string) {
  return dayNumber(toDay) - dayNumber(fromDay);
}

export function visibleDayIndex({
  scrollLeft,
  viewportWidth,
  dayWidth,
  dayCount,
}: {
  scrollLeft: number;
  viewportWidth: number;
  dayWidth: number;
  dayCount: number;
}) {
  if (!Number.isFinite(dayWidth) || dayWidth <= 0) {
    throw new RangeError("day width must be greater than zero");
  }
  if (!Number.isSafeInteger(dayCount) || dayCount < 0) {
    throw new RangeError("day count must be a non-negative integer");
  }
  if (dayCount === 0) return -1;

  const viewportCentre =
    Math.max(0, scrollLeft) + Math.max(0, viewportWidth) / 2;
  return Math.min(dayCount - 1, Math.floor(viewportCentre / dayWidth));
}

export function layoutSchedule<T extends ScheduleInterval>(
  intervals: T[],
  options: LayoutOptions,
) {
  const rangeStart = dayNumber(options.startDay);
  const rangeEnd = dayNumber(options.endDay);

  if (rangeEnd < rangeStart) {
    throw new Error("The timeline end day must not be before its start day.");
  }

  const visible = intervals.flatMap((interval) => {
    const startDay = calendarDayKey(
      interval.startsAt,
      interval.startsAtPrecision,
      options.timeZone,
    );
    const endDay = interval.endsAt
      ? calendarDayKey(
          interval.endsAt,
          interval.endsAtPrecision ?? "EXACT",
          options.timeZone,
        )
      : startDay;
    const start = dayNumber(startDay);
    const end = Math.max(start, dayNumber(endDay));

    if (end < rangeStart || start > rangeEnd) {
      return [];
    }

    return [
      {
        ...interval,
        startDay,
        endDay,
        startRow: Math.max(start, rangeStart) - rangeStart,
        endRow: Math.min(end, rangeEnd) - rangeStart,
        lane: -1,
        startsBeforeRange: start < rangeStart,
        endsAfterRange: end > rangeEnd,
      },
    ];
  });

  return timelineCategories.map((category) => {
    const categoryIntervals = visible
      .filter((interval) => interval.category === category)
      .sort(
        (left, right) =>
          left.startRow - right.startRow ||
          left.endRow - right.endRow ||
          left.key.localeCompare(right.key),
      );
    const overlapGroups: Array<typeof categoryIntervals> = [];
    let currentGroup: typeof categoryIntervals = [];
    let currentGroupEnd = -1;

    for (const interval of categoryIntervals) {
      if (currentGroup.length > 0 && interval.startRow > currentGroupEnd) {
        overlapGroups.push(currentGroup);
        currentGroup = [];
        currentGroupEnd = -1;
      }

      currentGroup.push(interval);
      currentGroupEnd = Math.max(currentGroupEnd, interval.endRow);
    }

    if (currentGroup.length > 0) {
      overlapGroups.push(currentGroup);
    }

    let categoryLaneCount = 0;
    const items = overlapGroups.flatMap((group) => {
      const laneEnds: number[] = [];
      const allocated = group.map((interval) => {
        const reusableLane = laneEnds.findIndex(
          (laneEnd) => laneEnd < interval.startRow,
        );
        const lane = reusableLane === -1 ? laneEnds.length : reusableLane;
        laneEnds[lane] = interval.endRow;

        return { ...interval, lane };
      });
      const groupLaneCount = Math.max(laneEnds.length, DEFAULT_VISIBLE_LANES);
      categoryLaneCount = Math.max(categoryLaneCount, laneEnds.length);

      return allocated.map((interval) => ({
        ...interval,
        groupLaneCount,
      }));
    });

    return {
      category,
      laneCount: categoryLaneCount,
      items,
    } satisfies ScheduleCategoryLayout<T>;
  });
}
