import {
  bannerDatasetSchema,
  bannerSourceKey,
  bannerPublicationTiming,
} from "./banner-dataset";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { jpBannerIdentityTargetHash } from "./jp-banner-identity";

export const JP_BANNER_COMPARISON_LIMITS = {
  maxBaselineBytes: 8 * 1_024 * 1_024,
  maxWindows: 400,
  maxMatches: 200,
  maxMatchesPerWindow: 10,
} as const;

type Inspection = NonNullable<
  Awaited<
    ReturnType<typeof inventoryJpBannerAnnouncements>
  >["articles"][number]["inspection"]
>;

/** Normalize review inputs only; HTML name identity does not prove pickup membership. */
function comparisonEvidence(inspection: Inspection) {
  const paragraphs = (inspection.pickupEvidence?.windows ?? []).map(
    (window) => ({
      evidenceKind: "PARAGRAPH_PICKUP" as const,
      periodEvidenceHash: window.periodEvidenceHash,
      sectionId: null as string | null,
      sectionEvidenceHash: null as string | null,
      subject: window.subject,
      knownIds: window.associations.map((member) => member.servantId),
      names:
        [] as Inspection["htmlPickupSections"]["sections"][number]["names"],
      issues: window.issues,
      projected: inspection.naProjection?.windows.find(
        (period) =>
          period.periodEvidenceHash === window.periodEvidenceHash &&
          period.status === "PROJECTED",
      ),
      basis: "KNOWN_SERVANT_OVERLAP_ONLY" as const,
    }),
  );
  const sections = inspection.htmlPickupSections.sections.map((section) => ({
    evidenceKind: "HTML_PICKUP_SECTION" as const,
    periodEvidenceHash: section.period?.evidenceHash ?? null,
    sectionId: section.sectionId,
    sectionEvidenceHash: section.evidenceHash,
    subject: null,
    knownIds: section.names.flatMap((member) =>
      member.identityStatus === "MATCHED" &&
      member.catalogueIdentity?.servantId != null
        ? [member.catalogueIdentity.servantId]
        : [],
    ),
    names: section.names,
    issues: [
      ...section.issues,
      ...(!section.names.length ? ["NO_SECTION_NAMES"] : []),
      ...(section.names.some(
        (member) =>
          member.identityStatus !== "MATCHED" ||
          member.catalogueIdentity?.servantId == null,
      )
        ? ["SECTION_NAME_IDENTITIES_UNRESOLVED"]
        : []),
    ],
    projected: inspection.naProjection?.htmlSectionWindows.find(
      (window) =>
        window.sectionId === section.sectionId &&
        window.sectionEvidenceHash === section.evidenceHash,
    ),
    basis: "CATALOGUE_NAME_OVERLAP_ONLY" as const,
  }));
  return [...paragraphs, ...sections];
}

/** Overlap is a review aid, never a persistent identity or proof of complete membership. */
export function compareJpBannerEvidence(
  report: Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>,
  baselineInput: unknown,
) {
  const baseline = bannerDatasetSchema
    .parse(baselineInput)
    .banners.map((banner) => ({
      sourceKey: bannerSourceKey(banner),
      contentHash: jpBannerIdentityTargetHash(banner),
      name: banner.name,
      status: banner.status,
      sourceSchedule: banner.sourceSchedule,
      servantIds: banner.servants.map((servant) => servant.id),
      timing:
        "startsAt" in banner
          ? bannerPublicationTiming(banner)
          : {
              startDate: banner.startDate,
              endDate: banner.endDate,
              timePrecision: "DATE_ONLY" as const,
            },
    }));
  let examinedWindows = 0,
    retainedMatches = 0,
    matchingPairs = 0;
  const windows = [];
  let unexaminedWindows = 0;
  for (const article of [...report.articles].sort((a, b) =>
    a.url.localeCompare(b.url),
  )) {
    const inspection = article.inspection;
    if (!inspection) continue;
    for (const window of comparisonEvidence(inspection)) {
      if (examinedWindows >= JP_BANNER_COMPARISON_LIMITS.maxWindows) {
        unexaminedWindows++;
        continue;
      }
      examinedWindows++;
      const projected =
        window.projected?.status === "PROJECTED" ? window.projected : undefined;
      const issues = [...window.issues];
      if (
        inspection.kind !== "SUMMON_CONTENT" ||
        inspection.restrictionEvidence
      )
        issues.push("NOTICE_NOT_ELIGIBLE_FOR_COMPARISON");
      if (!projected?.projectedStartsAt || !projected.projectedEndsAt)
        issues.push("PROJECTED_TIME_UNAVAILABLE");
      const knownIds = [...new Set(window.knownIds)].sort((a, b) => a - b);
      if (!knownIds.length)
        issues.push(
          window.evidenceKind === "PARAGRAPH_PICKUP"
            ? "NO_VERIFIED_PICKUP_MEMBERSHIP"
            : "NO_RESOLVED_SECTION_NAMES",
        );
      const matches = issues.length
        ? []
        : baseline
            .flatMap((banner) => {
              const shared = knownIds.filter((id) =>
                banner.servantIds.includes(id),
              );
              if (!shared.length) return [];
              return [
                {
                  baselineSourceKey: banner.sourceKey,
                  baselineContentHash: banner.contentHash,
                  baselineName: banner.name,
                  baselineStatus: banner.status,
                  baselineSourceSchedule: banner.sourceSchedule,
                  basis: window.basis,
                  sharedServantIds: shared,
                  knownServantIdsAbsentFromBaseline: knownIds.filter(
                    (id) => !banner.servantIds.includes(id),
                  ),
                  baselineServantIdsWithoutSourceEvidence:
                    banner.servantIds.filter((id) => !knownIds.includes(id)),
                  baselineTiming: banner.timing,
                  timingDifference:
                    "startsAt" in banner.timing
                      ? {
                          projectedMinusBaselineStartMs:
                            Date.parse(projected!.projectedStartsAt!) -
                            Date.parse(banner.timing.startsAt),
                          projectedMinusBaselineEndMs: banner.timing.endsAt
                            ? Date.parse(projected!.projectedEndsAt!) -
                              Date.parse(banner.timing.endsAt)
                            : null,
                        }
                      : null,
                  identityConfirmed: false as const,
                },
              ];
            })
            .sort(
              (a, b) =>
                b.sharedServantIds.length - a.sharedServantIds.length ||
                a.baselineServantIdsWithoutSourceEvidence.length -
                  b.baselineServantIdsWithoutSourceEvidence.length ||
                a.baselineSourceKey.localeCompare(b.baselineSourceKey),
            );
      matchingPairs += matches.length;
      const retained = matches.slice(
        0,
        Math.max(
          0,
          Math.min(
            JP_BANNER_COMPARISON_LIMITS.maxMatchesPerWindow,
            JP_BANNER_COMPARISON_LIMITS.maxMatches - retainedMatches,
          ),
        ),
      );
      retainedMatches += retained.length;
      windows.push({
        sourceUrl: article.url,
        articleContentHash: inspection.contentHash,
        evidenceKind: window.evidenceKind,
        sectionId: window.sectionId,
        sectionEvidenceHash: window.sectionEvidenceHash,
        names: window.names,
        periodEvidenceHash: window.periodEvidenceHash,
        subject: window.subject,
        knownServantIds: knownIds,
        projectedStartsAt: projected?.projectedStartsAt ?? null,
        projectedEndsAt: projected?.projectedEndsAt ?? null,
        sourcePendingEvidence: inspection.schedule.pendingEvidence,
        status: issues.length
          ? ("HELD" as const)
          : matches.length
            ? ("POSSIBLE_MATCHES" as const)
            : ("NO_OVERLAP_IN_BASELINE" as const),
        issues: [...new Set(issues)],
        matchingPairs: matches.length,
        matches: retained,
        matchesLimited: retained.length < matches.length,
        rosterComplete: false as const,
      });
    }
  }
  return {
    scope: "PARTIAL_JP_EVIDENCE_COMPARISON" as const,
    baselineBanners: baseline.length,
    articlesWithoutPickupEvidence: report.articles.filter(
      (article) =>
        article.inspectionStatus !== "NOT_RELEVANT" &&
        !article.inspection?.pickupEvidence?.windows.length &&
        !article.inspection?.htmlPickupSections.sections.length,
    ).length,
    examinedWindows,
    unexaminedWindows,
    matchingPairs,
    retainedMatches,
    comparisonLimited: unexaminedWindows > 0 || retainedMatches < matchingPairs,
    sourceCoverageLimited:
      report.coverageLimited ||
      report.inspectionLimited ||
      report.counts.unresolved > 0 ||
      report.counts.articlesAwaitingScheduleEvidence > 0 ||
      report.status !== "succeeded",
    scheduleCompleteness: "UNVERIFIED" as const,
    identityConfirmed: false as const,
    publicationAllowed: false as const,
    windows,
  };
}
