import { GLOBAL_CAMPAIGN_IDENTITY_LIMITS } from "../../shared/global-reconciliation-config";
import type { extractJpBannerSchedule } from "./jp-banner-schedule";

// JP: news.fate-go.jp/2026/10/grand_substitute_cp/ (daily login at 04:00).
// NA: webview.fate-go.us/iframe/2026/0901_25mdl/ (21:00 PDT = 04:00 UTC).
export const JP_BANNER_PROJECTION_RULE = {
  version: "jp-na-daily-reset-v1",
  jpResetHour: 4,
  naResetHourUtc: 4,
  projectionYears: 2,
} as const;
type Schedule = ReturnType<typeof extractJpBannerSchedule>;
type Period = Schedule["periods"][number];
type Kind =
  | "SUMMON_CONTENT"
  | "RESTRICTED_SUMMON_CONTENT"
  | "NOT_RELEVANT"
  | "UNRESOLVED";

function dayInstant(value: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : null;
}
function minuteInstant(value: string | null) {
  if (
    value === null ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/u.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : null;
}
function anchorInstants(jpDay: string, naDay: string) {
  const jp = dayInstant(jpDay),
    na = dayInstant(naDay);
  if (jp === null || na === null)
    throw new Error("Invalid projection anchor day.");
  return {
    jp:
      jp +
      JP_BANNER_PROJECTION_RULE.jpResetHour * 3_600_000 -
      GLOBAL_CAMPAIGN_IDENTITY_LIMITS.jstOffsetMinutes * 60_000,
    na: na + JP_BANNER_PROJECTION_RULE.naResetHourUtc * 3_600_000,
  };
}

/** Explicit common anchors allow future family matching without re-rounding each child. */
export function projectJpBannerPeriods(
  periods: readonly Period[],
  jpAnchorDay: string,
  naAnchorDay: string,
) {
  if (periods.length > 4_000)
    throw new Error("Projection period limit exceeded.");
  const anchors = anchorInstants(jpAnchorDay, naAnchorDay);
  return periods.map((period) => {
    const issues = [...period.issues];
    const start = minuteInstant(period.startsAt),
      end = minuteInstant(period.endsAt);
    if (!["ARTICLE_ENVELOPE", "LABELLED_SUMMON"].includes(period.scope))
      issues.push("NOT_A_LABELLED_SUMMON_PERIOD");
    if (period.timezone !== "JST" || period.timezoneBasis === "UNSUPPORTED")
      issues.push("UNSUPPORTED_SOURCE_TIMEZONE");
    if (start === null || end === null) issues.push("SOURCE_TIME_UNRESOLVED");
    else if (end < start) issues.push("REVERSED_PERIOD");
    const offsetStart = start === null ? null : start - anchors.jp;
    const offsetEnd = end === null ? null : end - anchors.jp;
    return {
      periodEvidenceHash: period.evidenceHash,
      scope: period.scope,
      subject: period.subject,
      status: issues.length ? ("HELD" as const) : ("PROJECTED" as const),
      sourceStartsAt: period.startsAt,
      sourceEndsAt: period.endsAt,
      startOffsetMs: offsetStart,
      endOffsetMs: offsetEnd,
      projectedStartsAt:
        issues.length || offsetStart === null
          ? null
          : new Date(anchors.na + offsetStart).toISOString(),
      projectedEndsAt:
        issues.length || offsetEnd === null
          ? null
          : new Date(anchors.na + offsetEnd).toISOString(),
      issues: [...new Set(issues)],
    };
  });
}

/** Notice-scoped estimates are previews, not verified persistent family anchors. */
export function previewJpBannerProjection(schedule: Schedule, kind: Kind) {
  const issues: string[] = [];
  if (kind === "RESTRICTED_SUMMON_CONTENT")
    issues.push("RESTRICTED_SUMMON_NOTICE");
  else if (kind !== "SUMMON_CONTENT") issues.push("NOTICE_EVIDENCE_UNRESOLVED");
  if (schedule.pendingEvidence.includes("INCOMPLETE_ARTICLE_EVIDENCE"))
    issues.push("INCOMPLETE_ARTICLE_EVIDENCE");
  const envelopes = schedule.periods.filter(
    (period) => period.scope === "ARTICLE_ENVELOPE",
  );
  const anchor = envelopes[0];
  let jpAnchorDay: string | null = null,
    naAnchorDay: string | null = null;
  if (
    envelopes.length !== 1 ||
    !anchor ||
    anchor.issues.length ||
    minuteInstant(anchor.startsAt) === null ||
    minuteInstant(anchor.endsAt) === null ||
    anchor.timezone !== "JST" ||
    anchor.timezoneBasis === "UNSUPPORTED" ||
    anchor.endsAt! < anchor.startsAt!
  )
    issues.push("NO_UNAMBIGUOUS_NOTICE_ANCHOR");
  else {
    const source = minuteInstant(envelopes[0]!.startsAt)!;
    jpAnchorDay = new Date(
      source + GLOBAL_CAMPAIGN_IDENTITY_LIMITS.jstOffsetMinutes * 60_000,
    )
      .toISOString()
      .slice(0, 10);
    const shifted = `${Number(jpAnchorDay.slice(0, 4)) + JP_BANNER_PROJECTION_RULE.projectionYears}${jpAnchorDay.slice(4)}`;
    if (dayInstant(shifted) === null)
      issues.push("UNSUPPORTED_CALENDAR_YEAR_SHIFT");
    else naAnchorDay = shifted;
  }
  const periods = schedule.periods.filter((period) =>
    ["ARTICLE_ENVELOPE", "LABELLED_SUMMON"].includes(period.scope),
  );
  const windows =
    jpAnchorDay && naAnchorDay && !issues.length
      ? projectJpBannerPeriods(periods, jpAnchorDay, naAnchorDay)
      : [];
  const projectedCount = windows.filter(
    (window) => window.status === "PROJECTED",
  ).length;
  return {
    scope: "NOTICE_PERIOD_TIMING_PREVIEW" as const,
    scheduleCompleteness: "UNVERIFIED" as const,
    rule: JP_BANNER_PROJECTION_RULE,
    status:
      issues.length || !projectedCount
        ? ("HELD" as const)
        : projectedCount === windows.length
          ? ("PROJECTED" as const)
          : ("PARTIAL" as const),
    anchorBasis: "NOTICE_ENVELOPE_RESET_ESTIMATE" as const,
    anchorPeriodEvidenceHash:
      envelopes.length === 1 ? envelopes[0]!.evidenceHash : null,
    jpAnchorDay,
    naAnchorDay,
    jpAnchorAt:
      jpAnchorDay === null
        ? null
        : new Date(anchorInstants(jpAnchorDay, jpAnchorDay).jp).toISOString(),
    naAnchorAt:
      naAnchorDay === null
        ? null
        : new Date(anchorInstants(naAnchorDay, naAnchorDay).na).toISOString(),
    unprojectedPeriodCount: periods.length - projectedCount,
    unparsedSourcePeriodCount: schedule.unparsedPeriods.length,
    issues,
    windows,
    sourcePendingEvidence: schedule.pendingEvidence,
    confirmation: "PROJECTED_NOT_CONFIRMED" as const,
    publicationAllowed: false as const,
  };
}
