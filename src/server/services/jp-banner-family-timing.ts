import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  JP_BANNER_IDENTITY_LIMITS,
  previewJpBannerIdentityMap,
} from "./jp-banner-identity";
import {
  bannerDatabaseFingerprint,
  loadBannerIdentityTargets,
} from "./banner-source-identity";
import {
  JP_BANNER_PROJECTION_RULE,
  jpBannerResetAnchors,
  projectJpBannerPeriods,
} from "./jp-banner-projection";
import {
  effectiveBanner,
  effectiveEvent,
  eventIsHidden,
} from "./effective-schedule";
import {
  publicDateEvidenceSelect,
  publicEventDateOverlaySelect,
  publicEventGlobalBaselineSelect,
} from "./global-baseline-select";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";

const key = z
  .string()
  .trim()
  .min(1)
  .max(JP_BANNER_IDENTITY_LIMITS.maxTargetKeyCharacters);
const day = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  }, "Invalid reset calendar day.");
export const jpBannerFamilyTimingSchema = z
  .object({
    version: z.literal(1),
    anchors: z
      .array(
        z
          .object({
            familySourceKey: key,
            eventSourceKey: key,
            jpResetDay: day,
            naResetDay: day,
            pickupSourceKeys: z
              .array(key)
              .min(1)
              .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
          })
          .strict(),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict()
  .superRefine((input, context) => {
    const families = new Set<string>(),
      pickups = new Set<string>();
    for (const anchor of input.anchors) {
      if (families.has(anchor.familySourceKey))
        context.addIssue({
          code: "custom",
          message: "Duplicate family anchor.",
        });
      families.add(anchor.familySourceKey);
      for (const pickup of anchor.pickupSourceKeys) {
        if (pickups.has(pickup))
          context.addIssue({
            code: "custom",
            message: "Duplicate pickup selection.",
          });
        pickups.add(pickup);
      }
    }
    if (pickups.size > JP_BANNER_IDENTITY_LIMITS.maxMappings)
      context.addIssue({
        code: "custom",
        message: "Pickup selection limit exceeded.",
      });
  });

const jpDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function timing(row: {
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: string;
  endsAtPrecision: string | null;
}) {
  return {
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    startsAtPrecision: row.startsAtPrecision,
    endsAtPrecision: row.endsAtPrecision,
  };
}

type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
type SourcePreview = ReturnType<typeof previewJpBannerIdentityMap>;

/** Reads only; the caller chooses a read-only snapshot or a locked write transaction. */
export async function loadJpBannerFamilyTiming(
  tx: PrismaClient | Prisma.TransactionClient,
  report: SourceReport,
  source: SourcePreview,
  input?: unknown,
) {
  const anchors =
    input === undefined ? [] : jpBannerFamilyTimingSchema.parse(input).anchors;
  const selections = new Map(
    anchors.flatMap((anchor) =>
      anchor.pickupSourceKeys.map((pickup) => [pickup, anchor] as const),
    ),
  );
  if (
    [...selections.keys()].some(
      (pickup) => !source.mappings.some((row) => row.sourceKey === pickup),
    )
  )
    throw new Error("Family timing selection is absent from the identity map.");
  const { byKey, byIdentity } = await loadBannerIdentityTargets(tx, source);
  const stored = await tx.bannerFamilyTimingAnchor.findMany({
    where: {
      familyId: {
        in: [
          ...new Set(
            [...byKey.values()].flatMap((row) =>
              row.familyId ? [row.familyId] : [],
            ),
          ),
        ],
      },
    },
    take: JP_BANNER_IDENTITY_LIMITS.maxMappings + 1,
  });
  if (stored.length > JP_BANNER_IDENTITY_LIMITS.maxMappings)
    throw new Error("Family anchor lookup limit exceeded.");
  const byStored = new Map(stored.map((row) => [row.familyId, row]));
  const events = await tx.event.findMany({
    where: {
      OR: [
        { sourceKey: { in: anchors.map((anchor) => anchor.eventSourceKey) } },
        { id: { in: stored.map((anchor) => anchor.anchorEventId) } },
      ],
    },
    include: {
      curation: true,
      globalBaseline: publicEventGlobalBaselineSelect,
      dateOverlay: publicEventDateOverlaySelect,
      dateEvidence: { ...publicDateEvidenceSelect, orderBy: { id: "asc" } },
    },
  });
  const byEvent = new Map(events.map((event) => [event.sourceKey, event]));
  const byEventId = new Map(events.map((event) => [event.id, event]));
  const mappings = source.mappings.map((mapping) => {
    const banner = byKey.get(mapping.targetSourceKey);
    const storedAnchor = banner?.familyId
      ? byStored.get(banner.familyId)
      : undefined;
    const storedEvent = storedAnchor
      ? byEventId.get(storedAnchor.anchorEventId)
      : undefined;
    const suppliedAnchor = selections.get(mapping.sourceKey);
    const anchor =
      suppliedAnchor ??
      (storedAnchor && storedEvent && banner?.family
        ? {
            familySourceKey: banner.family.sourceKey,
            eventSourceKey: storedEvent.sourceKey,
            jpResetDay: storedAnchor.jpResetDay.toISOString().slice(0, 10),
            naResetDay: storedAnchor.naResetDay.toISOString().slice(0, 10),
            pickupSourceKeys: [mapping.sourceKey],
          }
        : undefined);
    const identity = byIdentity.get(mapping.sourceKey);
    const event = anchor ? byEvent.get(anchor.eventSourceKey) : undefined;
    const effective = event ? effectiveEvent(event) : null;
    const current = banner ? effectiveBanner(banner) : null;
    const issues = [...mapping.issues];
    if (!anchor) issues.push("FAMILY_ANCHOR_NOT_SELECTED");
    if (!banner) issues.push("DATABASE_TARGET_NOT_FOUND");
    if (!identity) issues.push("IDENTITY_NOT_REGISTERED");
    if (
      identity &&
      (identity.bannerId !== banner?.id ||
        identity.sourceUrl !== mapping.sourceUrl)
    )
      issues.push("REGISTERED_IDENTITY_CONFLICT");
    if (
      byKey.has(mapping.sourceKey) &&
      byKey.get(mapping.sourceKey)!.id !== banner?.id
    )
      issues.push("DATABASE_BASE_KEY_COLLISION");
    if (
      banner &&
      mapping.knownServantIds.some(
        (id) => !banner.featured.some((member) => member.servantId === id),
      )
    )
      issues.push("DATABASE_PICKUP_MEMBER_ABSENT");
    if (!banner?.family || banner.family.sourceKey !== anchor?.familySourceKey)
      issues.push("BANNER_FAMILY_MISMATCH");
    if (!event) issues.push("ANCHOR_EVENT_NOT_FOUND");
    else {
      if (event.familyId !== banner?.familyId)
        issues.push("ANCHOR_EVENT_FAMILY_MISMATCH");
      if (event.sourceRegion !== "JP" || !event.sourceStartsAt)
        issues.push("JP_ANCHOR_SOURCE_UNAVAILABLE");
      if (event.sourceStartsAtPrecision === "DATE_ONLY")
        issues.push("JP_ANCHOR_SOURCE_DATE_ONLY");
      if (eventIsHidden(event)) issues.push("ANCHOR_EVENT_HIDDEN");
      if (
        ![
          "MAIN_EVENT",
          "CAMPAIGN",
          "PRE_RELEASE_CAMPAIGN",
          "QUEST_RELEASE",
        ].includes(event.type)
      )
        issues.push("UNSUPPORTED_ANCHOR_EVENT_TYPE");
      if (
        effective!.startsAtPrecision !== "EXACT" &&
        !(
          event.sourceStartsAtPrecision === "EXACT" &&
          effective!.dateConfirmation.startsAt === "PROJECTED"
        )
      )
        issues.push("ANCHOR_DATE_ONLY");
      if (
        anchor &&
        event.sourceStartsAt &&
        jpDate.format(event.sourceStartsAt) !== anchor.jpResetDay
      )
        issues.push("JP_ANCHOR_DAY_MISMATCH");
    }
    const resets = anchor
      ? jpBannerResetAnchors(anchor.jpResetDay, anchor.naResetDay)
      : null;
    const eventOffsetMs =
      event?.sourceStartsAt && resets
        ? event.sourceStartsAt.getTime() - resets.jp
        : null;
    const projectedEventStart =
      eventOffsetMs !== null && resets
        ? new Date(resets.na + eventOffsetMs)
        : null;
    const eventStartDifferenceMs =
      projectedEventStart && effective?.startsAtPrecision === "EXACT"
        ? projectedEventStart.getTime() - effective.startsAt.getTime()
        : null;
    const startAuthority = effective?.dateConfirmation.startsAt;
    if (
      (startAuthority === "OFFICIAL" || startAuthority === "CURATED") &&
      eventStartDifferenceMs !== 0
    )
      issues.push("PROTECTED_ANCHOR_START_CONFLICT");

    const article = report.articles.find(
      (row) => row.url === mapping.sourceUrl,
    )?.inspection;
    const period = article?.schedule.periods.find(
      (row) => row.evidenceHash === mapping.periodEvidenceHash,
    );
    const projection =
      anchor && period && !issues.length
        ? projectJpBannerPeriods(
            [period],
            anchor.jpResetDay,
            anchor.naResetDay,
          )[0]!
        : null;
    if (projection?.issues.length) issues.push(...projection.issues);
    if (projection && banner && current) {
      for (const [endpoint, candidate, value, precision, authority] of [
        [
          "START",
          projection.projectedStartsAt,
          current.startsAt,
          current.startsAtPrecision,
          banner.dateOverlay?.startStatus ?? banner.status,
        ],
        [
          "END",
          projection.projectedEndsAt,
          current.endsAt,
          current.endsAtPrecision,
          banner.dateOverlay?.endStatus ?? banner.status,
        ],
      ] as const) {
        if (
          (authority === "OFFICIAL" || authority === "CURATED") &&
          (precision !== "EXACT" || candidate !== value?.toISOString())
        )
          issues.push(`PROTECTED_BANNER_${endpoint}_CONFLICT`);
      }
    }
    const anchorFacts =
      event && effective && anchor
        ? {
            version: 1,
            rule: JP_BANNER_PROJECTION_RULE.version,
            familyId: banner?.familyId,
            eventFamilyId: event.familyId,
            eventId: event.id,
            eventSourceKey: event.sourceKey,
            eventType: event.type,
            sourceRegion: event.sourceRegion,
            sourceUrl: event.sourceUrl,
            sourceStartsAt: event.sourceStartsAt?.toISOString() ?? null,
            sourcePrecision: event.sourceStartsAtPrecision,
            jpResetDay: anchor.jpResetDay,
            naResetDay: anchor.naResetDay,
            targetStart:
              effective.startsAtPrecision === "EXACT"
                ? effective.startsAt.toISOString()
                : effective.startsAt.toISOString().slice(0, 10),
            targetPrecision: effective.startsAtPrecision,
            targetAuthority: startAuthority,
            hidden: eventIsHidden(event),
          }
        : null;
    const anchorFactsHash = anchorFacts
      ? createHash("sha256").update(JSON.stringify(anchorFacts)).digest("hex")
      : null;
    const anchorStatus =
      storedAnchor?.factsHash === anchorFactsHash &&
      storedAnchor?.anchorEventId === event?.id &&
      storedAnchor?.sourceUrl === event?.sourceUrl
        ? ("UNCHANGED" as const)
        : ("REVIEW_REQUIRED" as const);
    if (storedAnchor && !suppliedAnchor && anchorStatus !== "UNCHANGED")
      issues.push("ACCEPTED_FAMILY_ANCHOR_FACTS_CHANGED");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 2,
          rule: JP_BANNER_PROJECTION_RULE,
          anchor: anchor ?? null,
          storedAnchor: storedAnchor ?? null,
          mapping,
          identity: identity ?? null,
          event: event ?? null,
          banner: banner ? bannerDatabaseFingerprint(banner) : null,
        }),
      )
      .digest("hex");
    return {
      sourceKey: mapping.sourceKey,
      storedAnchor: storedAnchor ?? null,
      anchorStatus,
      anchorFactsHash,
      proposedAnchorRevision:
        anchorStatus === "UNCHANGED"
          ? storedAnchor!.revision
          : (storedAnchor?.revision ?? 0) + 1,
      bannerId: banner?.id ?? null,
      familyId: banner?.familyId ?? null,
      familySourceKey: banner?.family?.sourceKey ?? null,
      anchorEventId: event?.id ?? null,
      anchorEventSourceKey: event?.sourceKey ?? null,
      anchor: anchor
        ? {
            jpResetDay: anchor.jpResetDay,
            naResetDay: anchor.naResetDay,
            jpResetAt: new Date(resets!.jp).toISOString(),
            naResetAt: new Date(resets!.na).toISOString(),
            basis:
              startAuthority === "OFFICIAL" && eventStartDifferenceMs === 0
                ? "OFFICIAL_EVENT_ALIGNMENT_REQUIRES_REVIEW"
                : "PROPOSED_RESET_PAIR",
            eventStartOffsetMs: eventOffsetMs,
            eventStartDifferenceMs,
          }
        : null,
      event:
        event && effective
          ? {
              originalJpStartsAt: event.sourceStartsAt?.toISOString() ?? null,
              originalJpEndsAt: event.sourceEndsAt?.toISOString() ?? null,
              sourceStartsAtPrecision: event.sourceStartsAtPrecision,
              sourceEndsAtPrecision: event.sourceEndsAtPrecision,
              sourceUrl: event.sourceUrl,
              sourceContentHash: event.sourceContentHash,
              base: timing(event),
              effective: timing(effective),
              confirmation: effective.dateConfirmation,
              globalSourceUrl: effective.globalSourceUrl,
            }
          : null,
      current:
        current && banner
          ? {
              ...timing(current),
              status: current.status,
              startStatus: banner.dateOverlay?.startStatus ?? banner.status,
              endStatus:
                banner.dateOverlay?.endStatus ??
                (banner.endsAt ? banner.status : null),
            }
          : null,
      sourceInterval: period
        ? {
            sourceUrl: mapping.sourceUrl,
            articleContentHash: mapping.observedArticleContentHash,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
            evidenceHash: period.evidenceHash,
          }
        : null,
      projection,
      comparison: {
        startDifferenceMs:
          current?.startsAtPrecision === "EXACT" &&
          projection?.projectedStartsAt
            ? Date.parse(projection.projectedStartsAt) -
              current.startsAt.getTime()
            : null,
        endDifferenceMs:
          current?.endsAtPrecision === "EXACT" &&
          current.endsAt &&
          projection?.projectedEndsAt
            ? Date.parse(projection.projectedEndsAt) - current.endsAt.getTime()
            : null,
      },
      status: issues.length
        ? ("HELD" as const)
        : ("CONSISTENT_REVIEW_REQUIRED" as const),
      issues: [...new Set(issues)],
      unresolvedEvidence: [
        "FAMILY_RELATIONSHIP_REQUIRES_REVIEW",
        ...(event?.sourceStartsAtPrecision === "EXACT"
          ? []
          : ["SOURCE_ANCHOR_PRECISION_UNVERIFIED"]),
        "ROSTER_COMPLETENESS_UNVERIFIED",
      ],
      reviewFingerprint: fingerprint,
      publicationAllowed: false as const,
    };
  });
  return {
    scope: "JP_BANNER_FAMILY_TIMING_PREVIEW" as const,
    rule: JP_BANNER_PROJECTION_RULE,
    heldMappings: mappings.filter((row) => row.status === "HELD").length,
    mappings,
    databaseWrites: 0 as const,
    publicationAllowed: false as const,
  };
}

/** A consistent read-only review snapshot, never acceptance or publication. */
export async function previewJpBannerFamilyTiming(
  database: PrismaClient,
  report: SourceReport,
  baseline: unknown,
  map: unknown,
  input?: unknown,
) {
  const source = previewJpBannerIdentityMap(report, baseline, map);
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadJpBannerFamilyTiming(tx, report, source, input);
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
