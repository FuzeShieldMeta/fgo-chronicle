import {
  addCalendarYears,
  dayInstant,
  JST_OFFSET_MS,
  JP_NA_SCHEDULE_RULE,
  jpScheduleLaunchHour,
  projectJpScheduleBoundary,
} from "../../src/shared/schedule-time-projection.mjs";

// Shared with Atlas classification: longer source records are permanent wrappers.
export const PERMANENT_RECORD_DAYS = 366;

export const EVENT_BOUNDARY_PROJECTION_METHOD = "JP_NA_SCHEDULE_BOUNDARIES";
export const EVENT_PROJECTION_METHODS = [
  "TWO_CALENDAR_YEARS",
  EVENT_BOUNDARY_PROJECTION_METHOD,
];
/** @type {Readonly<Record<string, import("../../src/shared/schedule-time-projection.mjs").StartPolicy>>} */
const EVENT_START_POLICIES = Object.freeze({
  MAIN_EVENT: "LAUNCH",
  CAMPAIGN: "LAUNCH",
  PRE_RELEASE_CAMPAIGN: "LAUNCH",
  LOGIN_BONUS: "LOGIN",
  EVENT_SHOP: "LAUNCH",
  LIMITED_MISSION: "LAUNCH",
  QUEST_RELEASE: "LAUNCH",
});
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = DAY_MS / 24;

/** @param {string} value */
function sourceDay(value) {
  return new Date(Date.parse(value) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Project only source-backed event envelopes. Unsupported clocks retain their
 * existing date-only estimates and report a hold; original facts never change.
 * @param {{type: string, sourceStartsAt: string, sourceStartsAtPrecision: string | null,
 * sourceEndsAt: string | null, sourceEndsAtPrecision: string | null}} event
 */
export function projectJpEventTiming(event) {
  const legacyStart = addCalendarYears(
    new Date(event.sourceStartsAt),
    2,
  ).toISOString();
  const legacyEnd = event.sourceEndsAt
    ? addCalendarYears(new Date(event.sourceEndsAt), 2).toISOString()
    : null;
  const legacy = {
    startsAt: legacyStart,
    startsAtPrecision: "DATE_ONLY",
    endsAt: legacyEnd,
    endsAtPrecision: legacyEnd ? "DATE_ONLY" : null,
    projectionMethod: "TWO_CALENDAR_YEARS",
  };
  const startPolicy = Object.hasOwn(EVENT_START_POLICIES, event.type)
    ? EVENT_START_POLICIES[event.type]
    : undefined;
  if (!startPolicy) return { ...legacy, issues: [] };
  if (event.type === "QUEST_RELEASE") {
    const durationMs =
      Date.parse(event.sourceEndsAt ?? "") - Date.parse(event.sourceStartsAt);
    // Release markers and permanent availability are not finite schedule windows.
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > PERMANENT_RECORD_DAYS * DAY_MS
    )
      return { ...legacy, issues: [] };
  }
  if (
    event.type === "EVENT_SHOP" &&
    event.sourceStartsAt === event.sourceEndsAt
  )
    return { ...legacy, issues: ["SHOP_INTERVAL_UNRESOLVED"] };
  const jpDay = sourceDay(event.sourceStartsAt);
  const naDay = addCalendarYears(new Date(`${jpDay}T00:00:00.000Z`), 2)
    .toISOString()
    .slice(0, 10);
  if (dayInstant(jpDay) === null || dayInstant(naDay) === null)
    return { ...legacy, issues: ["UNSUPPORTED_CALENDAR_YEAR_SHIFT"] };
  const launchHour = jpScheduleLaunchHour(event.sourceStartsAt);
  const start =
    event.sourceStartsAtPrecision === "EXACT"
      ? projectJpScheduleBoundary(
          event.sourceStartsAt,
          jpDay,
          naDay,
          "START",
          launchHour,
          startPolicy,
        )
      : null;
  const end =
    event.sourceEndsAtPrecision === "EXACT" && event.sourceEndsAt
      ? projectJpScheduleBoundary(
          event.sourceEndsAt,
          jpDay,
          naDay,
          "END",
          launchHour,
        )
      : null;
  const issues = [...(start?.issues ?? []), ...(end?.issues ?? [])];
  // Without a known launch, relative offsets lack their source context.
  if (event.sourceStartsAtPrecision !== "EXACT" || !start?.projectedAt)
    return { ...legacy, issues };
  const startsAt = start.projectedAt;
  const endsAt = end?.projectedAt ?? legacyEnd;
  if (endsAt && endsAt < startsAt)
    return { ...legacy, issues: [...issues, "PROJECTED_PERIOD_REVERSED"] };
  return {
    startsAt,
    startsAtPrecision: "EXACT",
    endsAt,
    endsAtPrecision: endsAt ? (end?.projectedAt ? "EXACT" : "DATE_ONLY") : null,
    projectionMethod: EVENT_BOUNDARY_PROJECTION_METHOD,
    issues,
  };
}

/**
 * Reward dates here are the adapters' existing two-year estimates, before any
 * official or curator overlays. Retarget only an explicitly declared relation.
 * @template {Record<string, any>} T
 * @param {T} reward
 * @returns {T}
 * @param {string} sourceType
 * @param {Record<string, any>} event
 * @param {string} [sourceExpectedAt]
 */
export function projectEventRelativeReward(
  reward,
  sourceType,
  event,
  sourceExpectedAt,
) {
  if (
    !reward.expectedAt ||
    event.projectionMethod !== EVENT_BOUNDARY_PROJECTION_METHOD
  )
    return reward;
  if (reward.dateBasis === "EVENT_END" && event.endsAtPrecision === "EXACT")
    return { ...reward, expectedAt: event.endsAt };
  if (reward.dateBasis !== "START_RELATIVE") return reward;
  const oldStart = sourceExpectedAt
    ? Date.parse(event.sourceStartsAt)
    : addCalendarYears(new Date(event.sourceStartsAt), 2).getTime();
  let expectedAt;
  if (sourceType === "LOGIN_BONUS") {
    // Login rewards follow server days, not the main event's launch hour.
    const sourceAnchor = sourceExpectedAt
      ? event.sourceStartsAt
      : new Date(oldStart).toISOString();
    const targetDay = event.startsAt.slice(0, 10);
    const boundary = projectJpScheduleBoundary(
      sourceExpectedAt ?? reward.expectedAt,
      sourceDay(sourceAnchor),
      targetDay,
      "START",
      jpScheduleLaunchHour(event.sourceStartsAt),
      "LOGIN",
    );
    if (boundary.projectedAt) expectedAt = boundary.projectedAt;
    else {
      // Calendar-only login rows still establish server days, not exact clocks.
      const rewardDay = sourceDay(sourceExpectedAt ?? reward.expectedAt);
      const days =
        (Date.parse(rewardDay) - Date.parse(sourceDay(sourceAnchor))) / DAY_MS;
      const reset =
        Date.parse(`${targetDay}T00:00:00.000Z`) +
        JP_NA_SCHEDULE_RULE.naResetHourUtc * HOUR_MS;
      expectedAt = new Date(reset + days * DAY_MS).toISOString();
    }
  } else {
    expectedAt = new Date(
      Date.parse(event.startsAt) +
        Date.parse(sourceExpectedAt ?? reward.expectedAt) -
        oldStart,
    ).toISOString();
  }
  return { ...reward, expectedAt };
}

/** @param {Record<string, any>} event @param {string[]} issues */
export function eventTimingIssues(event, issues) {
  return issues.length
    ? [
        {
          sourceKey: `${event.sourceKey}:timing-review`,
          severity: "WARNING",
          message: `${event.name}: exact JP timing was held (${[...new Set(issues)].join(", ")}); affected endpoints retain date-only estimates.`,
        },
      ]
    : [];
}

/** Preserve ambiguous dates, but expose them instead of silently claiming alignment.
 * @param {Record<string, any>} event @param {Array<Record<string, any>>} sources */
export function unknownRewardTimingIssues(event, sources) {
  if (event.projectionMethod !== EVENT_BOUNDARY_PROJECTION_METHOD) return [];
  const count = sources
    .flatMap((source) => source.rewards)
    .filter(
      (reward) =>
        reward.expectedAt &&
        (!reward.dateBasis || reward.dateBasis === "UNKNOWN"),
    ).length;
  return count
    ? [
        {
          sourceKey: `${event.sourceKey}:reward-timing-review`,
          severity: "WARNING",
          message: `${event.name}: ${count} reward dates have no declared relationship to this event; their previous estimates were retained for review.`,
        },
      ]
    : [];
}

/** @param {Date} sourceDate @param {string} sourceType @param {Record<string, any>} [event] */
export function projectStartRelativeDate(sourceDate, sourceType, event) {
  const expectedAt = addCalendarYears(sourceDate, 2).toISOString();
  return event
    ? projectEventRelativeReward(
        { expectedAt, dateBasis: "START_RELATIVE" },
        sourceType,
        event,
        sourceDate.toISOString(),
      ).expectedAt
    : expectedAt;
}
