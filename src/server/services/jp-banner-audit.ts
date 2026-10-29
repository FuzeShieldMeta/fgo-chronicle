import { z } from "zod";
import { bannerDatasetSchema, bannerSourceKey } from "./banner-dataset";
import { jpBannerComparisonWindows } from "./jp-banner-comparison";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";

type ComparisonWindow =
  ReturnType<typeof jpBannerComparisonWindows> extends Generator<infer Window>
    ? Window
    : never;
type AuditPair = {
  pairKey: string;
  windowKey: string;
  sheetSourceKey: string;
  observedIdsAgree: boolean;
  sharedServantIds: number[];
  sheetIdsWithoutSourceEvidence: number[];
  sourceIdsNotOnSheet: number[];
  startDayDelta: number;
  endDayDelta: number | null;
  utcStartDayDelta: number;
  utcEndDayDelta: number | null;
  nearby: boolean;
  instantDifference: { startMs: number; endMs: number | null } | null;
  identityConfirmed: false;
  rosterComplete: false;
};
type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
export const JP_BANNER_AUDIT_LIMITS = {
  maxNotices: 2_000,
  maxWindows: 5_000,
  maxPairs: 200_000,
  nearbyCalendarDays: 7,
} as const;
export const jpBannerAuditOptionsSchema = z
  .object({
    from: z.iso.date(),
    through: z.iso.date(),
    sheetTimeZone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Unsupported spreadsheet time zone.")
      .optional(),
  })
  .strict()
  .refine((value) => value.from <= value.through, "Reversed audit horizon.");
const ordinal = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const equalIds = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** Exhaustive bounded evidence accounting, never accepted identities or publication input. */
export function auditJpBannerEvidence(
  reports: readonly SourceReport[],
  baselineInput: unknown,
  optionsInput: unknown,
  unavailableSources: readonly { url: string; reason: string }[] = [],
) {
  const options = jpBannerAuditOptionsSchema.parse(optionsInput);
  const baseline = bannerDatasetSchema.parse(baselineInput);
  const formatter = options.sheetTimeZone
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: options.sheetTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : null;
  const label = (instant: string) => {
    if (!formatter) return instant.slice(0, 10);
    const parts = formatter.formatToParts(new Date(instant));
    const value = (type: string) =>
      parts.find((part) => part.type === type)!.value;
    return `${value("year")}-${value("month")}-${value("day")}`;
  };
  const horizon = baseline.banners.filter((b) => {
    const start = "startDate" in b ? b.startDate : label(b.startsAt);
    const end = "endDate" in b ? b.endDate : b.endsAt ? label(b.endsAt) : null;
    return start <= options.through && (!end || end >= options.from);
  });
  const jp = horizon.filter((b) => b.sourceSchedule === "JP");
  const na = horizon.filter((b) => b.sourceSchedule === "NA");
  const sources: (ComparisonWindow & {
    windowKey: string;
    held: boolean;
    identityConfirmed: false;
    rosterComplete: false;
    publicationAllowed: false;
  })[] = [];
  let omittedWindows = 0;
  const sourceArticles = reports.flatMap((report) => report.articles);
  if (
    new Set(sourceArticles.map((article) => article.url)).size !==
    sourceArticles.length
  )
    throw new Error("Duplicate article in audit reports.");
  if (sourceArticles.length > JP_BANNER_AUDIT_LIMITS.maxNotices)
    throw new Error("Audit notice limit exceeded.");
  for (const report of reports)
    for (const window of jpBannerComparisonWindows(report)) {
      if (sources.length >= JP_BANNER_AUDIT_LIMITS.maxWindows) {
        omittedWindows++;
        continue;
      }
      sources.push({
        ...window,
        windowKey: `window:${sources.length + 1}`,
        held: window.issues.length > 0,
        identityConfirmed: false as const,
        rosterComplete: false as const,
        publicationAllowed: false as const,
      });
    }
  const pairs: AuditPair[] = [];
  const bySheet = new Map<string, AuditPair[]>(),
    byWindow = new Map<string, AuditPair[]>();
  const targets = jp.map((banner) => ({
    banner,
    ids: banner.servants.map((servant) => servant.id).sort((a, b) => a - b),
    idSet: new Set(banner.servants.map((servant) => servant.id)),
  }));
  let omittedPairs = 0;
  for (const source of sources) {
    if (source.held || !source.projectedStartsAt || !source.projectedEndsAt)
      continue;
    for (const { banner, ids, idSet } of targets) {
      const shared = source.knownServantIds.filter((id) => idSet.has(id));
      if (!shared.length) continue;
      if (pairs.length >= JP_BANNER_AUDIT_LIMITS.maxPairs) {
        omittedPairs++;
        continue;
      }
      const sheetStart =
        "startDate" in banner ? banner.startDate : label(banner.startsAt);
      const sheetEnd =
        "endDate" in banner
          ? banner.endDate
          : banner.endsAt
            ? label(banner.endsAt)
            : null;
      const startDayDelta =
        ordinal(label(source.projectedStartsAt)) - ordinal(sheetStart);
      const endDayDelta = sheetEnd
        ? ordinal(label(source.projectedEndsAt)) - ordinal(sheetEnd)
        : null;
      const pair: AuditPair = {
        pairKey: `pair:${pairs.length + 1}`,
        windowKey: source.windowKey,
        sheetSourceKey: bannerSourceKey(banner),
        observedIdsAgree: equalIds(ids, source.knownServantIds),
        sharedServantIds: shared,
        sheetIdsWithoutSourceEvidence: ids.filter(
          (id) => !source.knownServantIds.includes(id),
        ),
        sourceIdsNotOnSheet: source.knownServantIds.filter(
          (id) => !ids.includes(id),
        ),
        startDayDelta,
        endDayDelta,
        utcStartDayDelta:
          ordinal(source.projectedStartsAt.slice(0, 10)) - ordinal(sheetStart),
        utcEndDayDelta: sheetEnd
          ? ordinal(source.projectedEndsAt.slice(0, 10)) - ordinal(sheetEnd)
          : null,
        nearby:
          Math.abs(startDayDelta) <= JP_BANNER_AUDIT_LIMITS.nearbyCalendarDays,
        instantDifference:
          "startsAt" in banner
            ? {
                startMs:
                  Date.parse(source.projectedStartsAt) -
                  Date.parse(banner.startsAt),
                endMs: banner.endsAt
                  ? Date.parse(source.projectedEndsAt) -
                    Date.parse(banner.endsAt)
                  : null,
              }
            : null,
        identityConfirmed: false as const,
        rosterComplete: false as const,
      };
      pairs.push(pair);
      const sheetPairs = bySheet.get(pair.sheetSourceKey) ?? [];
      sheetPairs.push(pair);
      bySheet.set(pair.sheetSourceKey, sheetPairs);
      const windowPairs = byWindow.get(pair.windowKey) ?? [];
      windowPairs.push(pair);
      byWindow.set(pair.windowKey, windowPairs);
    }
  }
  const sheetReview = jp.map((banner) => {
    const related = bySheet.get(bannerSourceKey(banner)) ?? [];
    const agreed = related.filter(
      (pair) =>
        pair.observedIdsAgree &&
        pair.startDayDelta === 0 &&
        pair.endDayDelta === 0,
    );
    const exactNear = related.filter(
      (pair) => pair.observedIdsAgree && pair.nearby,
    );
    const partialNear = related.filter((pair) => pair.nearby);
    const sameIds = related.filter((pair) => pair.observedIdsAgree);
    const relation = agreed.length
      ? "OBSERVED_IDS_AND_CALENDAR_LABELS_AGREE"
      : exactNear.length
        ? "OBSERVED_IDS_AGREE_CALENDAR_LABELS_DIFFER"
        : partialNear.length
          ? "PARTIAL_IDS_OVERLAP_NEAR_DATE"
          : sameIds.length
            ? "OBSERVED_IDS_AGREE_OTHER_DATES"
            : "NO_NEARBY_COMPARABLE_EVIDENCE";
    return {
      sourceKey: bannerSourceKey(banner),
      name: banner.name,
      sourceSchedule: banner.sourceSchedule,
      relation,
      candidatePairKeys: related.map((pair) => pair.pairKey),
      preferredReviewPairKeys: (agreed.length
        ? agreed
        : exactNear.length
          ? exactNear
          : partialNear.length
            ? partialNear
            : sameIds
      ).map((pair) => pair.pairKey),
      soloRateUpComparison: "UNVERIFIED" as const,
      identityConfirmed: false as const,
      publicationAllowed: false as const,
    };
  });
  const sourceReview = sources.map((source) => ({
    ...source,
    candidatePairKeys: (byWindow.get(source.windowKey) ?? []).map(
      (pair) => pair.pairKey,
    ),
    nearbyPairKeys: (byWindow.get(source.windowKey) ?? [])
      .filter((pair) => pair.nearby)
      .map((pair) => pair.pairKey),
  }));
  const processingIncomplete =
    unavailableSources.length > 0 ||
    sourceArticles.some((article) => !article.inspection) ||
    omittedWindows > 0 ||
    omittedPairs > 0 ||
    reports.some(
      (report) =>
        report.status !== "succeeded" || report.articleFailures.length > 0,
    );
  const requiresReview =
    processingIncomplete ||
    sourceReview.some(
      (source) =>
        source.held ||
        !source.nearbyPairKeys.length ||
        source.sourcePendingEvidence.length > 0,
    ) ||
    sheetReview.some(
      (row) => row.relation !== "OBSERVED_IDS_AND_CALENDAR_LABELS_AGREE",
    ) ||
    reports.some(
      (report) => report.coverageLimited || report.inspectionLimited,
    );
  return {
    scope: "JP_BANNER_WHOLE_PERIOD_EVIDENCE_AUDIT" as const,
    status: processingIncomplete
      ? ("INCOMPLETE" as const)
      : requiresReview
        ? ("REVIEW_REQUIRED" as const)
        : ("COMPARED" as const),
    horizon: { from: options.from, through: options.through },
    calendarComparison: {
      projectedTimeZone: options.sheetTimeZone ?? "UTC",
      sheetTimeZone: options.sheetTimeZone ?? null,
      timezoneMeaning: options.sheetTimeZone
        ? "EXPLICIT_AUDIT_ASSUMPTION"
        : "UNKNOWN_DATE_ONLY_SHEET_ZONE",
      note: "Calendar-label deltas are not instant differences. A one-day difference is not automatically an error.",
    },
    limits: JP_BANNER_AUDIT_LIMITS,
    summary: {
      sourceArticles: sourceArticles.length,
      sourceWindows: sources.length,
      heldWindows: sources.filter((source) => source.held).length,
      sheetBanners: horizon.length,
      jpSheetBanners: jp.length,
      naSheetBanners: na.length,
      candidatePairs: pairs.length,
      omittedWindows,
      omittedPairs,
      sheetCategories: Object.fromEntries(
        [...new Set(sheetReview.map((row) => row.relation))].map((relation) => [
          relation,
          sheetReview.filter((row) => row.relation === relation).length,
        ]),
      ),
    },
    processingComplete: !processingIncomplete,
    requiresReview,
    replacementReady: false as const,
    publicationAllowed: false as const,
    databaseWrites: 0 as const,
    unavailableSources,
    articleReview: sourceArticles.map((article) => ({
      url: article.url,
      inspectionStatus: article.inspectionStatus,
      kind: article.inspection?.kind ?? null,
      reasons: article.inspection?.reasons ?? [],
      pendingEvidence: article.inspection?.schedule.pendingEvidence ?? [],
      windowKeys: sources
        .filter((source) => source.sourceUrl === article.url)
        .map((source) => source.windowKey),
    })),
    uninspectedArticles: sourceArticles
      .filter((article) => !article.inspection)
      .map((article) => ({
        url: article.url,
        state: article.inspectionStatus,
      })),
    archiveCoverageVerified: false as const,
    sourceReview,
    sheetReview,
    naSheetBanners: na,
    candidatePairs: pairs,
  };
}
