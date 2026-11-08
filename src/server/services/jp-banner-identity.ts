import { createHash } from "node:crypto";
import { z } from "zod";
import { BANNER_SYNC_LIMITS } from "../../shared/banner-sync-config.mjs";
import {
  bannerDatasetSchema,
  bannerSourceKey,
  type BannerDataset,
} from "./banner-dataset";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { JP_BANNER_SERVANT_SOURCE } from "./jp-banner-servants";
import { previewJpBannerRoster } from "./jp-banner-roster";

const MEBIBYTE = 1_024 * 1_024;
export const JP_BANNER_IDENTITY_LIMITS = {
  maxFileBytes: MEBIBYTE,
  maxMappings: 200,
  maxRegistryIdentities: 20_000,
  maxTargetKeyCharacters:
    BANNER_SYNC_LIMITS.maxTextCharacters + ":YYYY-MM-DD:YYYY-MM-DD".length,
} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const jpBannerIdentityMapSchema = z
  .object({
    version: z.literal(1),
    mappings: z
      .array(
        z
          .object({
            // Assigned once by the reviewer; never generated from mutable evidence.
            sourceKey: z
              .string()
              .max(BANNER_SYNC_LIMITS.maxTextCharacters)
              .regex(/^publisher:JP:pickup:[a-z0-9][a-z0-9_-]*$/u),
            sourceUrl: z.url().max(BANNER_SYNC_LIMITS.maxTextCharacters),
            articleContentHash: digest,
            periodEvidenceHash: digest,
            rosterReview: z
              .object({
                evidenceHash: digest,
                confirmCompleteRoster: z.literal(true),
                rateRule: z.literal("STANDARD_RATE_UP"),
                acknowledgeRemovedTargets: z.boolean(),
              })
              .strict()
              .optional(),
            htmlSection: z
              .object({
                sectionId: z
                  .string()
                  .min(1)
                  .max(BANNER_SYNC_LIMITS.maxTextCharacters),
                sectionEvidenceHash: digest,
                catalogueContentHash: digest,
              })
              .strict()
              .optional(),
            targetSourceKey: z
              .string()
              .trim()
              .min(1)
              .max(JP_BANNER_IDENTITY_LIMITS.maxTargetKeyCharacters),
            targetContentHash: digest,
          })
          .strict(),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict();

type Inspection = NonNullable<
  Awaited<
    ReturnType<typeof inventoryJpBannerAnnouncements>
  >["articles"][number]["inspection"]
>;
type ReviewSelection = Pick<
  z.infer<typeof jpBannerIdentityMapSchema>["mappings"][number],
  "periodEvidenceHash" | "htmlSection"
>;

/** The same exact source selection feeds identity review and family-clock review. */
export function selectJpBannerReviewPeriod(
  inspection: Inspection | null | undefined,
  selection: ReviewSelection,
) {
  const selector = selection.htmlSection;
  if (!selector) {
    const periods =
      inspection?.schedule.periods.filter(
        (period) => period.evidenceHash === selection.periodEvidenceHash,
      ) ?? [];
    return {
      period: periods.length === 1 ? periods[0]! : null,
      section: null,
      issues: [] as string[],
    };
  }
  const sections =
    inspection?.htmlPickupSections.sections.filter(
      (section) => section.sectionId === selector.sectionId,
    ) ?? [];
  const section = sections.length === 1 ? sections[0]! : null;
  const issues: string[] = [];
  if (!section) issues.push("HTML_SECTION_NOT_UNIQUE_OR_UNAVAILABLE");
  if (section && section.evidenceHash !== selector.sectionEvidenceHash)
    issues.push("HTML_SECTION_EVIDENCE_CHANGED");
  if (section && section.period?.evidenceHash !== selection.periodEvidenceHash)
    issues.push("SECTION_PERIOD_EVIDENCE_CHANGED");
  return {
    section,
    period:
      section?.period && !issues.length
        ? {
            ...section.period,
            // The DOM section supplies scope; it does not supply a campaign title.
            scope: "LABELLED_SUMMON" as const,
            subject: null,
            issues: [...section.issues],
          }
        : null,
    issues,
  };
}

/** Review snapshot only, not banner identity. Parse through the shared dataset schema first. */
export function jpBannerIdentityTargetHash(
  banner: BannerDataset["banners"][number],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...banner,
        servants: [...banner.servants].sort((a, b) => a.id - b.id),
        ...(banner.summonLineups === undefined
          ? {}
          : {
              summonLineups: [...banner.summonLineups]
                .sort((a, b) =>
                  a.sourceKey < b.sourceKey
                    ? -1
                    : a.sourceKey > b.sourceKey
                      ? 1
                      : 0,
                )
                .map((lineup) => ({
                  ...lineup,
                  servants: [...lineup.servants].sort(
                    (a, b) => a.servantId - b.servantId,
                  ),
                })),
            }),
      }),
    )
    .digest("hex");
}

export const jpBannerSourceSelectionSchema =
  jpBannerIdentityMapSchema.shape.mappings.element.omit({
    targetSourceKey: true,
    targetContentHash: true,
  });
type SourceSelection = z.infer<typeof jpBannerSourceSelectionSchema>;

/** Source-only checks shared by baseline review and database-ID adoption. */
export function inspectJpBannerIdentitySource(
  report: Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>,
  mapping: SourceSelection,
) {
  const issues: string[] = [];
  const articles = report.articles.filter(
    (article) => article.url === mapping.sourceUrl,
  );
  const inspection = articles.length === 1 ? articles[0]!.inspection : null;
  if (!inspection) issues.push("SOURCE_NOT_UNIQUELY_INSPECTED");
  else {
    if (inspection.contentHash !== mapping.articleContentHash)
      issues.push("ARTICLE_CONTENT_CHANGED");
    if (inspection.kind !== "SUMMON_CONTENT" || inspection.restrictionEvidence)
      issues.push("SOURCE_NOT_ELIGIBLE");
  }
  const selected = selectJpBannerReviewPeriod(inspection, mapping);
  const { period, section } = selected;
  issues.push(...selected.issues);
  const isSection = Boolean(mapping.htmlSection);
  const rosterProposal = previewJpBannerRoster(
    report,
    inspection,
    mapping.periodEvidenceHash,
  );
  const rosterReviewed = Boolean(
    mapping.rosterReview &&
    !isSection &&
    rosterProposal.status === "REQUIRES_ROSTER_REVIEW" &&
    mapping.rosterReview.evidenceHash === rosterProposal.evidenceHash,
  );
  if (mapping.rosterReview && !rosterReviewed)
    issues.push("ROSTER_REVIEW_EVIDENCE_CHANGED_OR_UNSUPPORTED");
  const windows =
    inspection?.pickupEvidence?.windows.filter(
      (window) => window.periodEvidenceHash === mapping.periodEvidenceHash,
    ) ?? [];
  const window = !isSection && windows.length === 1 ? windows[0] : null;
  if (!period || (!isSection && !window))
    issues.push("PICKUP_EVIDENCE_NOT_UNIQUE_OR_UNAVAILABLE");
  if (isSection) {
    if (!section?.names.length) issues.push("NO_RESOLVED_SECTION_NAMES");
    if (section?.issues.length) issues.push("PICKUP_EVIDENCE_UNRESOLVED");
    if (
      section?.names.some(
        (member) =>
          member.identityStatus !== "MATCHED" ||
          member.catalogueIdentity?.servantId == null,
      )
    )
      issues.push("SECTION_NAME_IDENTITIES_UNRESOLVED");
    if (
      report.servantCatalogue.status !== "SUCCEEDED" ||
      report.servantCatalogue.contentHash !==
        mapping.htmlSection!.catalogueContentHash ||
      section?.names.some(
        (member) =>
          member.catalogueIdentity?.contentHash !==
            mapping.htmlSection!.catalogueContentHash ||
          member.catalogueIdentity?.sourceUrl !== JP_BANNER_SERVANT_SOURCE,
      )
    )
      issues.push("SECTION_CATALOGUE_EVIDENCE_CHANGED");
    if (
      inspection?.schedule.pendingEvidence.includes(
        "INCOMPLETE_ARTICLE_EVIDENCE",
      )
    )
      issues.push("INCOMPLETE_ARTICLE_EVIDENCE");
  } else {
    const namedPickup = window?.associations.some(
      (member) =>
        member.basis === "EXACT_NAMED_PICKUP_PERIOD_AND_CATALOGUE_IDENTITY",
    );
    const ambiguousEnvelope =
      period?.scope === "ARTICLE_ENVELOPE" &&
      inspection?.schedule.pendingEvidence.some(
        (issue) =>
          issue === "INDIVIDUAL_PICKUP_WINDOWS_UNRESOLVED" ||
          issue === "IMAGE_SCHEDULE_UNINTERPRETED",
      );
    if (
      !namedPickup ||
      ambiguousEnvelope ||
      (period?.scope !== "LABELLED_SUMMON" &&
        period?.scope !== "ARTICLE_ENVELOPE")
    )
      issues.push("INDIVIDUAL_PICKUP_NOT_ESTABLISHED");
    if (period?.issues.length || window?.issues.length)
      issues.push("PICKUP_EVIDENCE_UNRESOLVED");
  }
  const knownServantIds = [
    ...new Set(
      isSection
        ? (section?.names.flatMap((member) =>
            member.identityStatus === "MATCHED" &&
            member.catalogueIdentity?.servantId != null
              ? [member.catalogueIdentity.servantId]
              : [],
          ) ?? [])
        : (window?.associations.map((member) => member.servantId) ?? []),
    ),
  ].sort((a, b) => a - b);
  if (!knownServantIds.length)
    issues.push(
      isSection ? "NO_RESOLVED_SECTION_NAMES" : "NO_VERIFIED_PICKUP_MEMBERSHIP",
    );
  const projection = isSection
    ? inspection?.naProjection?.htmlSectionWindows.find(
        (candidate) =>
          candidate.sectionId === mapping.htmlSection!.sectionId &&
          candidate.sectionEvidenceHash ===
            mapping.htmlSection!.sectionEvidenceHash,
      )
    : inspection?.naProjection?.windows.find(
        (candidate) =>
          candidate.periodEvidenceHash === mapping.periodEvidenceHash,
      );
  return {
    inspection,
    period,
    section,
    isSection,
    rosterProposal,
    rosterReviewed,
    window,
    knownServantIds,
    projection,
    issues,
  };
}

/** Explicit proposed bindings only. No fuzzy matching, fetching, rekeying or publication. */
export function previewJpBannerIdentityMap(
  report: Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>,
  baselineInput: unknown,
  mapInput: unknown,
) {
  const baseline = bannerDatasetSchema.parse(baselineInput);
  const proposal = jpBannerIdentityMapSchema.parse(mapInput);
  const targets = new Map(
    baseline.banners.map((banner) => [bannerSourceKey(banner), banner]),
  );
  function repeated(
    key: (mapping: (typeof proposal.mappings)[number]) => string,
  ) {
    const counts = new Map<string, number>();
    for (const mapping of proposal.mappings)
      counts.set(key(mapping), (counts.get(key(mapping)) ?? 0) + 1);
    return (mapping: (typeof proposal.mappings)[number]) =>
      counts.get(key(mapping))! > 1;
  }
  const duplicateIdentity = repeated((mapping) => mapping.sourceKey);
  const duplicateTarget = repeated((mapping) => mapping.targetSourceKey);
  const duplicateSource = repeated((mapping) =>
    JSON.stringify(
      mapping.htmlSection
        ? [
            mapping.sourceUrl,
            "HTML_PICKUP_SECTION",
            mapping.htmlSection.sectionId,
          ]
        : [mapping.sourceUrl, mapping.periodEvidenceHash],
    ),
  );
  const mappings = proposal.mappings.map((mapping) => {
    const issues: string[] = [];
    if (duplicateIdentity(mapping)) issues.push("DUPLICATE_PICKUP_IDENTITY");
    if (duplicateTarget(mapping)) issues.push("DUPLICATE_TARGET_ASSIGNMENT");
    if (duplicateSource(mapping)) issues.push("DUPLICATE_SOURCE_ASSIGNMENT");
    const evidence = inspectJpBannerIdentitySource(report, mapping);
    const {
      inspection,
      period,
      section,
      isSection,
      rosterProposal,
      rosterReviewed,
      window,
      knownServantIds,
      projection,
    } = evidence;
    issues.push(...evidence.issues);
    const target = targets.get(mapping.targetSourceKey);
    const targetContentHash = target
      ? jpBannerIdentityTargetHash(target)
      : null;
    if (!target) issues.push("TARGET_NOT_IN_BASELINE");
    else {
      if (targetContentHash !== mapping.targetContentHash)
        issues.push("TARGET_CONTENT_CHANGED");
      if (target.sourceSchedule !== "JP" || target.status !== "PROJECTED")
        issues.push("TARGET_NOT_PROJECTED_JP");
      if (
        rosterReviewed &&
        !target.servants.some((member) => knownServantIds.includes(member.id))
      )
        issues.push("ROSTER_TARGET_IDENTITY_REVIEW_REQUIRED");
      if (
        !rosterReviewed &&
        knownServantIds.some(
          (id) => !target.servants.some((member) => member.id === id),
        )
      )
        issues.push("KNOWN_PICKUP_MEMBER_ABSENT_FROM_TARGET");
    }
    if (
      targets.has(mapping.sourceKey) &&
      mapping.sourceKey !== mapping.targetSourceKey
    )
      issues.push("PICKUP_IDENTITY_ALREADY_USED_BY_OTHER_TARGET");
    const removedTargetServantIds =
      target?.servants
        .filter(
          (member) =>
            !rosterProposal.featured.some(
              (source) => source.servantId === member.id,
            ),
        )
        .map((member) => member.id) ?? [];
    if (
      rosterReviewed &&
      removedTargetServantIds.length &&
      !mapping.rosterReview?.acknowledgeRemovedTargets
    )
      issues.push("REMOVED_PLAN_TARGETS_REQUIRE_ACKNOWLEDGEMENT");
    return {
      sourceKey: mapping.sourceKey,
      sourceEvidenceKind: isSection
        ? ("HTML_PICKUP_SECTION" as const)
        : ("PARAGRAPH_PICKUP" as const),
      ...(mapping.htmlSection ? { htmlSection: mapping.htmlSection } : {}),
      registrationHolds: isSection
        ? ["HTML_SECTION_REGISTRATION_UNSUPPORTED"]
        : [],
      sectionNames: section?.names ?? [],
      rosterProposal,
      rosterReviewed,
      ...(mapping.rosterReview ? { rosterReview: mapping.rosterReview } : {}),
      removedTargetServantIds,
      sourceUrl: mapping.sourceUrl,
      periodEvidenceHash: mapping.periodEvidenceHash,
      targetSourceKey: mapping.targetSourceKey,
      targetName: target?.name ?? null,
      targetStatus: target?.status ?? null,
      targetSourceSchedule: target?.sourceSchedule ?? null,
      sourceSubject: period?.subject ?? null,
      expectedArticleContentHash: mapping.articleContentHash,
      observedArticleContentHash: inspection?.contentHash ?? null,
      expectedTargetContentHash: mapping.targetContentHash,
      observedTargetContentHash: targetContentHash,
      status: issues.length
        ? ("HELD" as const)
        : ("CONSISTENT_REVIEW_REQUIRED" as const),
      issues: [...new Set(issues)],
      knownServantIds,
      countedRosterReview: window?.countedRosterReview
        ? {
            ...window.countedRosterReview,
            catalogueContentHash: report.servantCatalogue.contentHash,
          }
        : null,
      targetServantIdsWithoutSourceEvidence:
        target?.servants
          .filter((member) => !knownServantIds.includes(member.id))
          .map((member) => member.id) ?? [],
      sourcePendingEvidence: inspection?.schedule.pendingEvidence ?? [],
      timingPreview: projection ?? null,
      unresolvedEvidence: [
        ...(isSection
          ? [
              "PICKUP_MEMBERSHIP_UNVERIFIED",
              "HTML_SECTION_PUBLICATION_UNSUPPORTED",
            ]
          : []),
        "ROSTER_COMPLETENESS_UNVERIFIED",
        "FAMILY_IDENTITY_UNVERIFIED",
        "DATABASE_TARGET_ID_AND_OWNERSHIP_UNVERIFIED",
        "PERSISTENT_IDENTITY_HISTORY_UNVERIFIED",
        ...(projection?.status === "PROJECTED"
          ? ["FAMILY_PROJECTION_ANCHOR_UNVERIFIED"]
          : ["PROJECTED_TIME_UNAVAILABLE"]),
      ],
      identityConfirmed: false as const,
      humanReviewRequired: true as const,
      publicationAllowed: false as const,
    };
  });
  const heldMappings = mappings.filter(
    (mapping) => mapping.status === "HELD",
  ).length;
  return {
    scope: "JP_BANNER_IDENTITY_MAPPING_PREVIEW" as const,
    status:
      heldMappings === mappings.length
        ? ("HELD" as const)
        : heldMappings
          ? ("PARTIAL" as const)
          : ("CONSISTENT_REVIEW_REQUIRED" as const),
    consistentMappings: mappings.length - heldMappings,
    heldMappings,
    mappings,
    identityConfirmed: false as const,
    humanReviewRequired: true as const,
    publicationAllowed: false as const,
    databaseWrites: 0,
  };
}
