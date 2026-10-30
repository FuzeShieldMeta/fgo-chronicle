// Pure JP → Global projection, shared by Node imports and server previews.
export const JP_NA_SCHEDULE_RULE = {
  version: "jp-na-boundaries-v3",
  jpResetHour: 0,
  jpLaunchHour: 18,
  jpLateLaunchHour: 20,
  jpMaintenanceHour: 13,
  jpLoginHour: 4,
  naResetHourUtc: 4,
  projectionYears: 2,
};
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const JST_OFFSET_MS = 9 * HOUR_MS;
/** @param {string} value */
export function dayInstant(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : null;
}
/** @param {string | null} value */
export function sourceInstant(value) {
  if (
    value === null ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : null;
}
/** @param {string} jpDay @param {string} naDay */
export function scheduleResetAnchors(jpDay, naDay) {
  const jp = dayInstant(jpDay),
    na = dayInstant(naDay);
  if (jp === null || na === null)
    throw new Error("Invalid projection anchor day.");
  return {
    jp: jp + JP_NA_SCHEDULE_RULE.jpResetHour * HOUR_MS - JST_OFFSET_MS,
    na: na + JP_NA_SCHEDULE_RULE.naResetHourUtc * HOUR_MS,
  };
}

/** A notice/family's explicit standard launch determines offsets for its children. */
/** @param {string | null} value */
export function jpScheduleLaunchHour(value) {
  const instant = sourceInstant(value);
  if (instant === null) return JP_NA_SCHEDULE_RULE.jpLaunchHour;
  const hour = new Date(instant + JST_OFFSET_MS).getUTCHours();
  return hour === JP_NA_SCHEDULE_RULE.jpLateLaunchHour
    ? JP_NA_SCHEDULE_RULE.jpLateLaunchHour
    : JP_NA_SCHEDULE_RULE.jpLaunchHour;
}

/** Map one endpoint using its standard JP transition, never a player timezone. */
/** @param {string | null} value @param {string} jpAnchorDay @param {string} naAnchorDay
 * @param {"START" | "END"} endpoint @param {number} [launchHourJst]
 * @param {"LAUNCH" | "LOGIN"} [startBoundaryKind] */
export function projectJpScheduleBoundary(
  value,
  jpAnchorDay,
  naAnchorDay,
  endpoint,
  launchHourJst = JP_NA_SCHEDULE_RULE.jpLaunchHour,
  startBoundaryKind = "LAUNCH",
) {
  if (
    launchHourJst !== JP_NA_SCHEDULE_RULE.jpLaunchHour &&
    launchHourJst !== JP_NA_SCHEDULE_RULE.jpLateLaunchHour
  )
    throw new Error("Unsupported JP launch anchor.");
  if (!["LAUNCH", "LOGIN"].includes(startBoundaryKind))
    throw new Error("Unsupported JP start boundary.");
  const anchors = scheduleResetAnchors(jpAnchorDay, naAnchorDay);
  const instant = sourceInstant(value);
  if (instant === null)
    return {
      projectedAt: null,
      offsetMs: null,
      boundary: null,
      issues: ["SOURCE_TIME_UNRESOLVED"],
    };
  const jst = new Date(instant + JST_OFFSET_MS);
  const sourceDay = dayInstant(jst.toISOString().slice(0, 10));
  if (sourceDay === null)
    return {
      projectedAt: null,
      offsetMs: null,
      boundary: null,
      issues: ["SOURCE_TIME_UNRESOLVED"],
    };
  const hour = jst.getUTCHours();
  const referenceDay = anchors.jp + JST_OFFSET_MS;
  const calendarDayOffset = (sourceDay - referenceDay) / DAY_MS;
  const rule = JP_NA_SCHEDULE_RULE;
  /** @type {"MIDNIGHT" | "LAUNCH" | "MAINTENANCE" | "LOGIN"} */
  let kind;
  let boundaryHour;
  if (endpoint === "START") {
    if (startBoundaryKind === "LOGIN" && hour === rule.jpLoginHour) {
      kind = "LOGIN";
      boundaryHour = rule.jpLoginHour;
    } else if (
      hour === rule.jpResetHour &&
      jst.getUTCMinutes() === 0 &&
      jst.getUTCSeconds() === 0
    ) {
      kind = "MIDNIGHT";
      boundaryHour = rule.jpResetHour;
    } else if (hour >= rule.jpLaunchHour) {
      kind = "LAUNCH";
      boundaryHour = launchHourJst;
    } else {
      return {
        projectedAt: null,
        offsetMs: null,
        boundary: null,
        issues: ["NONSTANDARD_JP_START_REQUIRES_REVIEW"],
      };
    }
  } else {
    // Recognise the final hour before a known transition. Other clocks are held,
    // rather than assigned to whichever boundary happens to be nearest.
    /** @type {Array<{kind: "MIDNIGHT" | "MAINTENANCE" | "LAUNCH" | "LOGIN", hour: number}>} */
    const transitions = [
      { kind: "MIDNIGHT", hour: 24 },
      { kind: "MAINTENANCE", hour: rule.jpMaintenanceHour },
      { kind: "LAUNCH", hour: rule.jpLaunchHour },
      { kind: "LAUNCH", hour: rule.jpLateLaunchHour },
      { kind: "LOGIN", hour: rule.jpLoginHour },
    ];
    const transition = transitions.find((candidate) => {
      const isInHourBeforeTransition = hour === candidate.hour - 1;
      // Midnight is stored as 24 to associate 23:59 with the following day,
      // but the source clock represents midnight as hour 0.
      const transitionClockHour = candidate.hour % 24;
      const isExactlyAtTransition =
        hour === transitionClockHour &&
        jst.getUTCMinutes() === 0 &&
        jst.getUTCSeconds() === 0;

      return isInHourBeforeTransition || isExactlyAtTransition;
    });
    if (!transition)
      return {
        projectedAt: null,
        offsetMs: null,
        boundary: null,
        issues: ["NONSTANDARD_JP_END_REQUIRES_REVIEW"],
      };
    kind = transition.kind;
    boundaryHour = hour === 0 ? 0 : transition.hour;
  }
  const sourceBoundary = sourceDay + boundaryHour * HOUR_MS - JST_OFFSET_MS;
  const clockOffsetMs = instant - sourceBoundary;
  const boundaryDayOffset = calendarDayOffset + (boundaryHour === 24 ? 1 : 0);
  const targetBoundary = anchors.na + boundaryDayOffset * DAY_MS;
  const offsetMs = boundaryDayOffset * DAY_MS + clockOffsetMs;
  return {
    projectedAt: new Date(targetBoundary + clockOffsetMs).toISOString(),
    offsetMs,
    boundary: {
      kind,
      sourceBoundaryAt: new Date(sourceBoundary).toISOString(),
      targetBoundaryAt: new Date(targetBoundary).toISOString(),
      calendarDayOffset: boundaryDayOffset,
      clockOffsetMs,
    },
    issues: [],
  };
}

/**
 * Add calendar years while keeping the UTC month, time, and the nearest valid
 * day of that month.
 * @param {Date} value
 * @param {number} years
 */
export function addCalendarYears(value, years) {
  const result = new Date(value);
  const month = value.getUTCMonth();
  const day = value.getUTCDate();

  result.setUTCDate(1);
  result.setUTCFullYear(value.getUTCFullYear() + years);
  result.setUTCMonth(month);

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), month + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
