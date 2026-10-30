import type {
  extractJpBannerSchedule,
  JpBannerHtmlPickupSection,
} from "./jp-banner-schedule";

import {
  JP_NA_SCHEDULE_RULE,
  JST_OFFSET_MS,
  dayInstant,
  sourceInstant,
  scheduleResetAnchors,
  jpScheduleLaunchHour,
  projectJpScheduleBoundary,
} from "../../shared/schedule-time-projection.mjs";

// Preserve reviewed banner anchor fingerprints while sharing the clock engine.
export const JP_BANNER_PROJECTION_RULE = {
  ...JP_NA_SCHEDULE_RULE,
  version: "jp-na-banner-boundaries-v3",
} as const;
type Schedule = ReturnType<typeof extractJpBannerSchedule>;
type Period = Schedule["periods"][number];
type Kind =
  | "SUMMON_CONTENT"
  | "RESTRICTED_SUMMON_CONTENT"
  | "NOT_RELEVANT"
  | "UNRESOLVED";

function minuteInstant(value: string | null) {
  return value?.match(/:00\.000Z$/u) ? sourceInstant(value) : null;
}
export const jpBannerResetAnchors = scheduleResetAnchors;
export const jpBannerLaunchHour = jpScheduleLaunchHour;
export function projectJpBannerBoundary(
  value: string | null,
  jpAnchorDay: string,
  naAnchorDay: string,
  endpoint: "START" | "END",
  launchHourJst: number = JP_BANNER_PROJECTION_RULE.jpLaunchHour,
) {
  return projectJpScheduleBoundary(
    minuteInstant(value) === null ? null : value,
    jpAnchorDay,
    naAnchorDay,
    endpoint,
    launchHourJst,
  );
}

/** Shared calendar anchors retain sibling day spacing; each endpoint keeps its boundary offset. */
export function projectJpBannerPeriods(
  periods: readonly Period[],
  jpAnchorDay: string,
  naAnchorDay: string,
  launchHourJst: number = JP_BANNER_PROJECTION_RULE.jpLaunchHour,
) {
  if (periods.length > 4_000)
    throw new Error("Projection period limit exceeded.");
  jpBannerResetAnchors(jpAnchorDay, naAnchorDay);
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
    const projectedStart = projectJpBannerBoundary(
      period.startsAt,
      jpAnchorDay,
      naAnchorDay,
      "START",
      launchHourJst,
    );
    const projectedEnd = projectJpBannerBoundary(
      period.endsAt,
      jpAnchorDay,
      naAnchorDay,
      "END",
      launchHourJst,
    );
    issues.push(...projectedStart.issues, ...projectedEnd.issues);
    if (
      projectedStart.projectedAt &&
      projectedEnd.projectedAt &&
      projectedEnd.projectedAt < projectedStart.projectedAt
    )
      issues.push("PROJECTED_PERIOD_REVERSED");
    return {
      periodEvidenceHash: period.evidenceHash,
      scope: period.scope,
      subject: period.subject,
      status: issues.length ? ("HELD" as const) : ("PROJECTED" as const),
      sourceStartsAt: period.startsAt,
      sourceEndsAt: period.endsAt,
      startOffsetMs: projectedStart.offsetMs,
      endOffsetMs: projectedEnd.offsetMs,
      startBoundary: projectedStart.boundary,
      endBoundary: projectedEnd.boundary,
      projectedStartsAt: issues.length ? null : projectedStart.projectedAt,
      projectedEndsAt: issues.length ? null : projectedEnd.projectedAt,
      issues: [...new Set(issues)],
    };
  });
}

/** Notice-scoped estimates are previews, not verified persistent family anchors. */
export function previewJpBannerProjection(
  schedule: Schedule,
  kind: Kind,
  htmlSections: readonly JpBannerHtmlPickupSection[] = [],
) {
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
    jpAnchorDay = new Date(source + JST_OFFSET_MS).toISOString().slice(0, 10);
    const shifted = `${Number(jpAnchorDay.slice(0, 4)) + JP_BANNER_PROJECTION_RULE.projectionYears}${jpAnchorDay.slice(4)}`;
    if (dayInstant(shifted) === null)
      issues.push("UNSUPPORTED_CALENDAR_YEAR_SHIFT");
    else naAnchorDay = shifted;
  }
  const launchHourJst = jpBannerLaunchHour(anchor?.startsAt ?? null);
  if (!issues.length && anchor && jpAnchorDay && naAnchorDay) {
    const launch = projectJpBannerBoundary(
      anchor.startsAt,
      jpAnchorDay,
      naAnchorDay,
      "START",
      launchHourJst,
    );
    issues.push(...launch.issues);
  }
  const periods = schedule.periods.filter((period) =>
    ["ARTICLE_ENVELOPE", "LABELLED_SUMMON"].includes(period.scope),
  );
  const visiblePeriods = issues.length ? [] : periods;
  const sectionSources = htmlSections.map((section) => ({
    section,
    issues: [...new Set([...issues, ...section.issues])],
  }));
  const htmlPeriods = sectionSources.flatMap(({ section, issues }) =>
    section.period
      ? [
          {
            section,
            period: {
              ...section.period,
              // Scope comes from the HTML adapter, never a fabricated source title.
              scope: "LABELLED_SUMMON" as const,
              subject: null,
              evidenceHash: section.evidenceHash,
              issues,
            },
          },
        ]
      : [],
  );
  // Normalize both evidence formats before the shared endpoint projection pass.
  const projections =
    jpAnchorDay && naAnchorDay
      ? projectJpBannerPeriods(
          [...visiblePeriods, ...htmlPeriods.map(({ period }) => period)],
          jpAnchorDay,
          naAnchorDay,
          launchHourJst,
        )
      : [];
  // Projection results retain the normalized input order and source association.
  const windows = projections.slice(0, visiblePeriods.length);
  const bySection = new Map(
    htmlPeriods.map(({ section }, index) => [
      section,
      projections[visiblePeriods.length + index],
    ]),
  );
  const projectedCount = windows.filter(
    (window) => window.status === "PROJECTED",
  ).length;
  const htmlSectionWindows = sectionSources.map(
    ({ section, issues: sectionIssues }) => {
      const period = section.period;
      const projection = bySection.get(section);
      return {
        sectionId: section.sectionId,
        sourceUrl: section.sourceUrl,
        sectionEvidenceHash: section.evidenceHash,
        names: section.names,
        sourceStartsAt: period?.startsAt ?? null,
        sourceEndsAt: period?.endsAt ?? null,
        status: projection?.status ?? "HELD",
        projectedStartsAt: projection?.projectedStartsAt ?? null,
        projectedEndsAt: projection?.projectedEndsAt ?? null,
        startOffsetMs: projection?.startOffsetMs ?? null,
        endOffsetMs: projection?.endOffsetMs ?? null,
        startBoundary: projection?.startBoundary ?? null,
        endBoundary: projection?.endBoundary ?? null,
        issues: projection?.issues ?? sectionIssues,
        identityStatus: "UNRESOLVED" as const,
        rosterComplete: false as const,
        publicationAllowed: false as const,
      };
    },
  );
  const projectedHtmlCount = htmlSectionWindows.filter(
    (window) => window.status === "PROJECTED",
  ).length;
  const totalProjectedCount = projectedCount + projectedHtmlCount;
  return {
    scope: "NOTICE_PERIOD_TIMING_PREVIEW" as const,
    scheduleCompleteness: "UNVERIFIED" as const,
    rule: JP_BANNER_PROJECTION_RULE,
    status:
      issues.length || !totalProjectedCount
        ? ("HELD" as const)
        : totalProjectedCount === windows.length + htmlSectionWindows.length
          ? ("PROJECTED" as const)
          : ("PARTIAL" as const),
    anchorBasis: "NOTICE_ENVELOPE_RESET_ESTIMATE" as const,
    launchHourJst,
    anchorPeriodEvidenceHash:
      envelopes.length === 1 ? envelopes[0]!.evidenceHash : null,
    jpAnchorDay,
    naAnchorDay,
    jpAnchorAt:
      jpAnchorDay === null
        ? null
        : new Date(
            jpBannerResetAnchors(jpAnchorDay, jpAnchorDay).jp,
          ).toISOString(),
    naAnchorAt:
      naAnchorDay === null
        ? null
        : new Date(
            jpBannerResetAnchors(naAnchorDay, naAnchorDay).na,
          ).toISOString(),
    unprojectedPeriodCount: periods.length - projectedCount,
    unprojectedHtmlSectionCount: htmlSectionWindows.length - projectedHtmlCount,
    unparsedSourcePeriodCount: schedule.unparsedPeriods.length,
    issues,
    windows,
    htmlSectionWindows,
    sourcePendingEvidence: schedule.pendingEvidence,
    confirmation: "PROJECTED_NOT_CONFIRMED" as const,
    publicationAllowed: false as const,
  };
}
