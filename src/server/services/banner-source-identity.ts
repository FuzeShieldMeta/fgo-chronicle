import {
  lockSourcePublicationAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import {
  jpBannerIdentityMapSchema,
  JP_BANNER_IDENTITY_LIMITS,
  previewJpBannerIdentityMap,
  jpBannerSourceSelectionSchema,
  inspectJpBannerIdentitySource,
} from "./jp-banner-identity";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { isJpBannerPickupUrl } from "./jp-banner-source-url";

type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
type SourcePreview = ReturnType<typeof previewJpBannerIdentityMap>;
type SourceMapping = Pick<
  SourcePreview["mappings"][number],
  | "sourceKey"
  | "sourceUrl"
  | "periodEvidenceHash"
  | "expectedArticleContentHash"
  | "issues"
  | "registrationHolds"
  | "rosterReviewed"
  | "knownServantIds"
  | "rosterProposal"
  | "rosterReview"
> &
  (
    | {
        targetSourceKey: string;
        targetBannerId?: never;
        databaseTargetReview?: false;
      }
    | {
        targetBannerId: string;
        targetSourceKey?: never;
        databaseTargetReview: true;
      }
  );
type IdentityReview = { mappings: SourceMapping[] };
type Database = PrismaClient | Prisma.TransactionClient;
const mappingSchema = jpBannerIdentityMapSchema.shape.mappings.element;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const bannerIdentityAcceptanceSchema = z
  .object({
    version: z.literal(1),
    reason: z
      .string()
      .trim()
      .min(GLOBAL_SOURCE_LIMITS.minPublicationReasonLength)
      .max(GLOBAL_SOURCE_LIMITS.maxPublicationReasonLength),
    bindings: z
      .array(
        mappingSchema.omit({ htmlSection: true }).extend({
          sourceUrl: mappingSchema.shape.sourceUrl.refine(
            isJpBannerPickupUrl,
            "Unsupported pickup notice URL.",
          ),
          bannerId: z.string().min(1).max(100),
          expectedDatabaseFingerprint: digest,
        }),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict();

// Database-first adoption deliberately has no CSV key or content fingerprint.
const adoptionBinding = jpBannerSourceSelectionSchema
  .omit({ htmlSection: true })
  .extend({
    sourceUrl: mappingSchema.shape.sourceUrl.refine(
      isJpBannerPickupUrl,
      "Unsupported pickup notice URL.",
    ),
    rosterReview: mappingSchema.shape.rosterReview.unwrap(),
    bannerId: z.string().min(1).max(100),
  });
export const bannerSourceAdoptionMapSchema = z
  .object({
    version: z.literal(1),
    bindings: z
      .array(adoptionBinding.strict())
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict();
export const bannerSourceAdoptionAcceptanceSchema = z
  .object({
    version: z.literal(1),
    reason: bannerIdentityAcceptanceSchema.shape.reason,
    bindings: z
      .array(
        adoptionBinding
          .extend({ expectedDatabaseFingerprint: digest })
          .strict(),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict();

const snapshotInclude = {
  sourcePublication: true,
  family: { include: { curation: true } },
  dateOverlay: true,
  featured: { orderBy: { servantId: "asc" } },
  summonLineups: {
    orderBy: { id: "asc" },
    include: { featured: { orderBy: { servantId: "asc" } } },
  },
} satisfies Prisma.BannerInclude;
type Snapshot = Prisma.BannerGetPayload<{ include: typeof snapshotInclude }>;

// Deliberately separate from the local dataset fingerprint: this includes DB IDs,
// curator visibility, family, overlays and lineup references used by saved plans.
export function bannerDatabaseFingerprint(banner: Snapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify({ version: 3, banner }, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(
            Object.entries(value).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          );
        return value;
      }),
    )
    .digest("hex");
}

function eligible(banner: Snapshot) {
  return (
    banner.status === "PROJECTED" &&
    banner.sourceRegion === "JP_PROJECTED" &&
    banner.dateOverlay?.startStatus !== "OFFICIAL" &&
    banner.dateOverlay?.endStatus !== "OFFICIAL"
  );
}

export async function loadBannerIdentityTargets(
  database: Database,
  source: IdentityReview,
) {
  const keys = [
    ...new Set(
      source.mappings.flatMap((mapping) => [
        mapping.sourceKey,
        ...(mapping.targetSourceKey ? [mapping.targetSourceKey] : []),
      ]),
    ),
  ];
  const [banners, identities] = await Promise.all([
    database.banner.findMany({
      where: {
        OR: [
          { sourceKey: { in: keys } },
          {
            id: {
              in: source.mappings.flatMap((mapping) =>
                mapping.targetBannerId ? [mapping.targetBannerId] : [],
              ),
            },
          },
        ],
      },
      include: snapshotInclude,
    }),
    database.bannerSourceIdentity.findMany({
      where: {
        OR: [
          {
            sourceKey: {
              in: source.mappings.map((mapping) => mapping.sourceKey),
            },
          },
          {
            sourceUrl: {
              in: source.mappings.map((mapping) => mapping.sourceUrl),
            },
          },
        ],
      },
      take: JP_BANNER_IDENTITY_LIMITS.maxRegistryIdentities + 1,
    }),
  ]);
  if (identities.length > JP_BANNER_IDENTITY_LIMITS.maxRegistryIdentities)
    throw new Error("Source identity review budget exceeded.");
  const byKey = new Map(banners.map((banner) => [banner.sourceKey, banner]));
  const byIdentity = new Map(
    identities.map((identity) => [identity.sourceKey, identity]),
  );
  return {
    byKey,
    byId: new Map(banners.map((banner) => [banner.id, banner])),
    byIdentity,
    identities,
  };
}

async function databasePreview<Mapping extends SourceMapping>(
  database: Database,
  source: { mappings: Mapping[] },
) {
  const { byKey, byId, byIdentity, identities } =
    await loadBannerIdentityTargets(database, source);
  const mappings = source.mappings.map((mapping) => {
    const issues = [...mapping.issues, ...mapping.registrationHolds];
    if (!isJpBannerPickupUrl(mapping.sourceUrl))
      issues.push("UNSUPPORTED_SOURCE_URL");
    const banner =
      mapping.targetBannerId !== undefined
        ? byId.get(mapping.targetBannerId)
        : byKey.get(mapping.targetSourceKey);
    const collision = byKey.get(mapping.sourceKey);
    const identity = byIdentity.get(mapping.sourceKey);
    if (
      identities.some(
        (registered) =>
          registered.sourceKey !== mapping.sourceKey &&
          registered.sourceUrl === mapping.sourceUrl &&
          (mapping.databaseTargetReview === true ||
            (registered.periodEvidenceHash === mapping.periodEvidenceHash &&
              registered.bannerId !== banner?.id)),
      )
    )
      issues.push("SOURCE_WINDOW_ALREADY_REGISTERED");
    if (!banner) issues.push("DATABASE_TARGET_NOT_FOUND");
    else {
      if (!eligible(banner)) issues.push("DATABASE_TARGET_NOT_PROJECTED_JP");
      if (
        mapping.rosterReviewed &&
        !banner.featured.some((member) =>
          mapping.knownServantIds.includes(member.servantId),
        )
      )
        issues.push("ROSTER_TARGET_IDENTITY_REVIEW_REQUIRED");
      if (
        !mapping.rosterReviewed &&
        mapping.knownServantIds.some(
          (id) => !banner.featured.some((member) => member.servantId === id),
        )
      )
        issues.push("DATABASE_PICKUP_MEMBER_ABSENT");
      if (
        mapping.rosterReviewed &&
        (banner.hidden ||
          banner.summonLineups.length ||
          banner.family?.curation?.active ||
          banner.dateOverlay)
      )
        issues.push("ROSTER_PROTECTED_OR_LINEUP_TARGET");
      if (
        mapping.rosterReviewed &&
        !mapping.rosterReview?.acknowledgeRemovedTargets &&
        banner.featured.some(
          (member) => !mapping.knownServantIds.includes(member.servantId),
        )
      )
        issues.push("REMOVED_PLAN_TARGETS_REQUIRE_ACKNOWLEDGEMENT");
      if (collision && collision.id !== banner.id)
        issues.push("DATABASE_BASE_KEY_COLLISION");
      if (identity && identity.bannerId !== banner.id)
        issues.push("IDENTITY_ALREADY_BOUND_TO_ANOTHER_BANNER");
    }
    if (
      identity &&
      (identity.sourceUrl !== mapping.sourceUrl ||
        identity.articleContentHash !== mapping.expectedArticleContentHash ||
        identity.periodEvidenceHash !== mapping.periodEvidenceHash)
    )
      issues.push("REGISTERED_EVIDENCE_CHANGED");
    return {
      ...mapping,
      targetSourceKey: banner?.sourceKey ?? mapping.targetSourceKey ?? null,
      bannerId: banner?.id ?? null,
      removedTargetServantIds:
        banner?.featured
          .filter(
            (member) =>
              !mapping.rosterProposal.featured.some(
                (source) => source.servantId === member.servantId,
              ),
          )
          .map((member) => member.servantId) ?? [],
      databaseFingerprint: banner ? bannerDatabaseFingerprint(banner) : null,
      registrationStatus: issues.length
        ? ("HELD" as const)
        : identity
          ? ("ALREADY_REGISTERED" as const)
          : ("READY_TO_REGISTER" as const),
      issues,
      identityConfirmed: Boolean(identity && !issues.length),
      publicationAllowed: false as const,
    };
  });
  return {
    scope: "JP_BANNER_DATABASE_IDENTITY_PREVIEW" as const,
    mappings,
    databaseWrites: 0 as const,
    publicationAllowed: false as const,
  };
}

/** Read-only DB snapshot. Source consistency does not grant publication ownership. */
export async function previewBannerSourceIdentities(
  database: Database,
  report: SourceReport,
  baseline: unknown,
  map: unknown,
) {
  return databasePreview(
    database,
    previewJpBannerIdentityMap(report, baseline, map),
  );
}

/** Source checks run before locks; all DB checks, bindings and audits are atomic. */
export async function registerBannerSourceIdentities(
  database: PrismaClient,
  authorization: string | GlobalSourceAuthority,
  report: SourceReport,
  baseline: unknown,
  rawInput: unknown,
) {
  const input = bannerIdentityAcceptanceSchema.parse(rawInput);
  if (
    typeof authorization !== "string" &&
    input.bindings.some((binding) => binding.rosterReview)
  )
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Roster identity adoption requires a curator review.",
    });
  const map = {
    version: 1,
    mappings: input.bindings.map(
      ({
        bannerId: _id,
        expectedDatabaseFingerprint: _fingerprint,
        ...mapping
      }) => mapping,
    ),
  };
  const source = previewJpBannerIdentityMap(report, baseline, map);
  if (
    source.heldMappings ||
    source.mappings.some((mapping) => mapping.registrationHolds.length)
  )
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Source or baseline evidence changed. Review the identity proposal again.",
    });
  return registerIdentityReviews(database, authorization, source, input);
}

async function registerIdentityReviews(
  database: PrismaClient,
  authorization: string | GlobalSourceAuthority,
  source: IdentityReview,
  input: {
    reason: string;
    bindings: {
      sourceKey: string;
      bannerId: string;
      expectedDatabaseFingerprint: string;
    }[];
  },
) {
  const actorId =
    typeof authorization === "string" ? authorization : authorization.actorId;
  if (
    source.mappings.some(
      (mapping) => mapping.issues.length || mapping.registrationHolds.length,
    )
  )
    throw new TRPCError({
      code: "CONFLICT",
      message: "Source evidence changed. Review the identity proposal again.",
    });
  const expected = new Map(
    input.bindings.map((binding) => [binding.sourceKey, binding]),
  );
  return database.$transaction(
    async (tx) => {
      await lockSourcePublicationAuthority(tx, authorization);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const ids = [
        ...new Set(input.bindings.map((binding) => binding.bannerId)),
      ].sort();
      await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY "id" FOR UPDATE`;
      const current = await databasePreview(tx, source);
      for (const mapping of current.mappings) {
        const binding = expected.get(mapping.sourceKey)!;
        if (
          mapping.registrationStatus === "HELD" ||
          mapping.bannerId !== binding.bannerId ||
          mapping.databaseFingerprint !== binding.expectedDatabaseFingerprint
        )
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The banner or identity binding changed. Refresh the database preview before accepting.",
          });
      }
      let registered = 0;
      for (const mapping of current.mappings) {
        if (mapping.registrationStatus === "ALREADY_REGISTERED") continue;
        const binding = expected.get(mapping.sourceKey)!;
        const identity = await tx.bannerSourceIdentity.create({
          data: {
            sourceKey: mapping.sourceKey,
            bannerId: binding.bannerId,
            sourceUrl: mapping.sourceUrl,
            articleContentHash: mapping.expectedArticleContentHash,
            periodEvidenceHash: mapping.periodEvidenceHash,
          },
        });
        await tx.curatorChange.create({
          data: {
            actorId,
            targetKind: "BANNER",
            targetId: binding.bannerId,
            action: "BIND_SOURCE_IDENTITY",
            reason: input.reason,
            before: { sourceIdentity: null },
            after: {
              sourceKey: identity.sourceKey,
              bannerId: identity.bannerId,
              sourceUrl: identity.sourceUrl,
              articleContentHash: identity.articleContentHash,
              periodEvidenceHash: identity.periodEvidenceHash,
              databaseFingerprint: binding.expectedDatabaseFingerprint,
              ...(mapping.rosterReview
                ? {
                    rosterReview: mapping.rosterReview,
                    proposedRoster: mapping.rosterProposal.featured,
                  }
                : {}),
            },
          },
        });
        registered++;
      }
      return {
        registered,
        unchanged: input.bindings.length - registered,
        publicationAllowed: false as const,
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}

function adoptionSourceReview(report: SourceReport, rawMap: unknown) {
  const input = bannerSourceAdoptionMapSchema.parse(rawMap);
  const mappings = input.bindings.map((binding) => {
    const evidence = inspectJpBannerIdentitySource(report, binding);
    const issues = [...evidence.issues];
    if (report.status !== "succeeded" || report.articleFailures.length)
      issues.push("SOURCE_COLLECTION_INCOMPLETE");
    if (!evidence.rosterReviewed)
      issues.push("REVIEWED_SOURCE_ROSTER_REQUIRED");
    if (
      input.bindings.filter((row) => row.bannerId === binding.bannerId).length >
      1
    )
      issues.push("DUPLICATE_TARGET_ASSIGNMENT");
    if (
      input.bindings.filter((row) => row.sourceKey === binding.sourceKey)
        .length > 1
    )
      issues.push("DUPLICATE_PICKUP_IDENTITY");
    if (
      input.bindings.filter(
        (row) =>
          row.sourceUrl === binding.sourceUrl &&
          row.periodEvidenceHash === binding.periodEvidenceHash,
      ).length > 1
    )
      issues.push("DUPLICATE_SOURCE_ASSIGNMENT");
    return {
      sourceKey: binding.sourceKey,
      sourceUrl: binding.sourceUrl,
      periodEvidenceHash: binding.periodEvidenceHash,
      expectedArticleContentHash: binding.articleContentHash,
      targetBannerId: binding.bannerId,
      issues,
      registrationHolds: [] as string[],
      rosterReviewed: evidence.rosterReviewed,
      knownServantIds: evidence.knownServantIds,
      rosterProposal: evidence.rosterProposal,
      rosterReview: binding.rosterReview,
      databaseTargetReview: true as const,
    };
  });
  return { mappings };
}

/** Read-only adoption review by actual DB ID. Legacy source keys are opaque. */
export async function previewBannerSourceAdoptions(
  database: PrismaClient,
  report: SourceReport,
  rawMap: unknown,
) {
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return databasePreview(tx, adoptionSourceReview(report, rawMap));
    },
    {
      isolationLevel: "RepeatableRead",
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}

/** Explicit curator adoption only; shared locks, collision checks and audit writer. */
export async function adoptBannerSourceIdentities(
  database: PrismaClient,
  actorId: string,
  report: SourceReport,
  rawInput: unknown,
) {
  if (typeof actorId !== "string")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Database target adoption requires a curator review.",
    });
  const input = bannerSourceAdoptionAcceptanceSchema.parse(rawInput);
  const source = adoptionSourceReview(report, {
    version: input.version,
    bindings: input.bindings.map(
      ({ expectedDatabaseFingerprint: _fingerprint, ...binding }) => binding,
    ),
  });
  return registerIdentityReviews(database, actorId, source, input);
}
