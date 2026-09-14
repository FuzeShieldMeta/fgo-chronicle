import { timelineSchedule } from "~/app/timeline/_lib/timeline-layout-config";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const dayMilliseconds = 24 * 60 * 60 * 1_000;

export type TimelineWindowDefinition = {
  index: number;
  fromDay: string;
  throughDay: string;
};

export type TimelineWindowData<
  TEntry extends { key: string },
  TIncome extends { id: string },
> = TimelineWindowDefinition & {
  entries: TEntry[];
  incomeContributions: TIncome[];
};

function parseDay(day: string) {
  if (!dayPattern.test(day)) {
    throw new Error(`Invalid calendar day: ${day}`);
  }

  const value = new Date(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(value.getTime()) ||
    value.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`Invalid calendar day: ${day}`);
  }

  return value;
}

function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addCalendarMonths(day: string, monthCount: number) {
  const source = parseDay(day);
  const targetMonth = source.getUTCMonth() + monthCount;
  const target = new Date(
    Date.UTC(source.getUTCFullYear(), targetMonth, 1, 0, 0, 0, 0),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return dayKey(target);
}

function addCalendarYears(day: string, yearCount: number) {
  const source = parseDay(day);
  const targetYear = source.getUTCFullYear() + yearCount;
  const target = new Date(
    Date.UTC(targetYear, source.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const lastDay = new Date(
    Date.UTC(targetYear, source.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return dayKey(target);
}

function previousDay(day: string) {
  return dayKey(new Date(parseDay(day).getTime() - dayMilliseconds));
}

export function timelineWindows(scheduleStartDay: string) {
  parseDay(scheduleStartDay);
  const scheduleEndDay = addCalendarYears(
    scheduleStartDay,
    timelineSchedule.yearsAhead,
  );
  const windows: TimelineWindowDefinition[] = [];

  for (let index = 0; ; index += 1) {
    const fromMonthOffset = index === 0 ? 0 : 1 + (index - 1) * 3;
    const nextMonthOffset = index === 0 ? 1 : 1 + index * 3;
    const fromDay = addCalendarMonths(scheduleStartDay, fromMonthOffset);
    if (fromDay > scheduleEndDay) break;

    const throughDay = [
      previousDay(addCalendarMonths(scheduleStartDay, nextMonthOffset)),
      scheduleEndDay,
    ].sort()[0]!;

    windows.push({ index, fromDay, throughDay });
    if (throughDay === scheduleEndDay) break;
  }

  return windows;
}

export function timelineWindowAt(scheduleStartDay: string, index: number) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Timeline window ${index} is outside the schedule.`);
  }

  const window = timelineWindows(scheduleStartDay)[index];
  if (!window) {
    throw new Error(`Timeline window ${index} is outside the schedule.`);
  }
  return window;
}

export function prioritiseTimelineWindowIndexes({
  scheduleStartDay,
  loadedIndexes,
  sessionDays,
}: {
  scheduleStartDay: string;
  loadedIndexes: ReadonlySet<number>;
  sessionDays: readonly string[];
}) {
  const windows = timelineWindows(scheduleStartDay);
  const sessionIndexes = new Set<number>();

  for (const sessionDay of sessionDays) {
    const window = windows.find(
      ({ fromDay, throughDay }) =>
        sessionDay >= fromDay && sessionDay <= throughDay,
    );
    if (window && !loadedIndexes.has(window.index)) {
      sessionIndexes.add(window.index);
    }
  }

  return [
    ...[...sessionIndexes].sort((left, right) => left - right),
    ...windows.flatMap(({ index }) =>
      loadedIndexes.has(index) || sessionIndexes.has(index) ? [] : [index],
    ),
  ];
}

export function mergeContiguousTimelineWindows<
  TEntry extends { key: string },
  TIncome extends { id: string },
>(windows: ReadonlyMap<number, TimelineWindowData<TEntry, TIncome>>) {
  const entries = new Map<string, TEntry>();
  const incomeContributions = new Map<string, TIncome>();
  let index = 0;
  let throughDay: string | null = null;

  while (windows.has(index)) {
    const window = windows.get(index)!;
    for (const entry of window.entries) entries.set(entry.key, entry);
    for (const contribution of window.incomeContributions) {
      incomeContributions.set(contribution.id, contribution);
    }
    throughDay = window.throughDay;
    index += 1;
  }

  if (throughDay === null) {
    throw new Error("The initial timeline window is missing.");
  }

  return {
    entries: [...entries.values()],
    incomeContributions: [...incomeContributions.values()],
    throughDay,
    contiguousWindowCount: index,
  };
}
