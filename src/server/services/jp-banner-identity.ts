import { createHash } from "node:crypto";
import { z } from "zod";
import { BANNER_SYNC_LIMITS } from "../../shared/banner-sync-config.mjs";
import {
  bannerDatasetSchema,
  bannerSourceKey,
  type BannerDataset,
} from "./banner-dataset";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";

const MEBIBYTE = 1_024 * 1_024;
export const JP_BANNER_IDENTITY_LIMITS = {
  maxFileBytes: MEBIBYTE,
  maxMappings: 200,
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
            sourceUrl: z
              .string()
              .url()
              .max(BANNER_SYNC_LIMITS.maxTextCharacters),
            articleContentHash: digest,
            periodEvidenceHash: digest,
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
    JSON.stringify([mapping.sourceUrl, mapping.periodEvidenceHash]),
  );
  const mappings = proposal.mappings.map((mapping) => {
    const issues: string[] = [];
    if (duplicateIdentity(mapping)) issues.push("DUPLICATE_PICKUP_IDENTITY");
    if (duplicateTarget(mapping)) issues.push("DUPLICATE_TARGET_ASSIGNMENT");
    if (duplicateSource(mapping)) issues.push("DUPLICATE_SOURCE_ASSIGNMENT");
    const articles = report.articles.filter(
      (article) => article.url === mapping.sourceUrl,
    );
    const inspection = articles.length === 1 ? articles[0]!.inspection : null;
    if (!inspection) issues.push("SOURCE_NOT_UNIQUELY_INSPECTED");
    else {
      if (inspection.contentHash !== mapping.articleContentHash)
        issues.push("ARTICLE_CONTENT_CHANGED");
      if (
        inspection.kind !== "SUMMON_CONTENT" ||
        inspection.restrictionEvidence
      )
        issues.push("SOURCE_NOT_ELIGIBLE");
    }
    const periods =
      inspection?.schedule.periods.filter(
        (period) => period.evidenceHash === mapping.periodEvidenceHash,
      ) ?? [];
    const windows =
      inspection?.pickupEvidence?.windows.filter(
        (window) => window.periodEvidenceHash === mapping.periodEvidenceHash,
      ) ?? [];
    const period = periods.length === 1 ? periods[0] : null;
    const window = windows.length === 1 ? windows[0] : null;
    if (!period || !window)
      issues.push("PICKUP_EVIDENCE_NOT_UNIQUE_OR_UNAVAILABLE");
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
    const knownServantIds = [
      ...new Set(window?.associations.map((member) => member.servantId) ?? []),
    ].sort((a, b) => a - b);
    if (!knownServantIds.length) issues.push("NO_VERIFIED_PICKUP_MEMBERSHIP");
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
    const projection = inspection?.naProjection?.windows.find(
      (candidate) =>
        candidate.periodEvidenceHash === mapping.periodEvidenceHash,
    );
    return {
      sourceKey: mapping.sourceKey,
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
      issues,
      knownServantIds,
      targetServantIdsWithoutSourceEvidence:
        target?.servants
          .filter((member) => !knownServantIds.includes(member.id))
          .map((member) => member.id) ?? [],
      sourcePendingEvidence: inspection?.schedule.pendingEvidence ?? [],
      timingPreview: projection ?? null,
      unresolvedEvidence: [
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
