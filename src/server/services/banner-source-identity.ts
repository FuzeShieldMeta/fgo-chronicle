import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import {
  jpBannerIdentityMapSchema,
  JP_BANNER_IDENTITY_LIMITS,
  previewJpBannerIdentityMap,
} from "./jp-banner-identity";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";

type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
type SourcePreview = ReturnType<typeof previewJpBannerIdentityMap>;
type Database = PrismaClient | Prisma.TransactionClient;
const mappingSchema = jpBannerIdentityMapSchema.shape.mappings.element;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceUrl = /^https:\/\/news\.fate-go\.jp\/[0-9]{4}\/[A-Za-z0-9_-]+\/$/u;
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
        mappingSchema.extend({
          sourceUrl: mappingSchema.shape.sourceUrl.regex(sourceUrl),
          bannerId: z.string().min(1).max(100),
          expectedDatabaseFingerprint: digest,
        }),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .strict();

const snapshotInclude = {
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
      JSON.stringify({ version: 1, banner }, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
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

async function databasePreview(database: Database, source: SourcePreview) {
  const keys = [
    ...new Set(
      source.mappings.flatMap((mapping) => [
        mapping.sourceKey,
        mapping.targetSourceKey,
      ]),
    ),
  ];
  const [banners, identities] = await Promise.all([
    database.banner.findMany({
      where: { sourceKey: { in: keys } },
      include: snapshotInclude,
    }),
    database.bannerSourceIdentity.findMany({
      where: {
        sourceKey: { in: source.mappings.map((mapping) => mapping.sourceKey) },
      },
    }),
  ]);
  const byKey = new Map(banners.map((banner) => [banner.sourceKey, banner]));
  const byIdentity = new Map(
    identities.map((identity) => [identity.sourceKey, identity]),
  );
  const mappings = source.mappings.map((mapping) => {
    const issues = [...mapping.issues];
    if (!sourceUrl.test(mapping.sourceUrl))
      issues.push("UNSUPPORTED_SOURCE_URL");
    const banner = byKey.get(mapping.targetSourceKey);
    const collision = byKey.get(mapping.sourceKey);
    const identity = byIdentity.get(mapping.sourceKey);
    if (!banner) issues.push("DATABASE_TARGET_NOT_FOUND");
    else {
      if (!eligible(banner)) issues.push("DATABASE_TARGET_NOT_PROJECTED_JP");
      if (
        mapping.knownServantIds.some(
          (id) => !banner.featured.some((member) => member.servantId === id),
        )
      )
        issues.push("DATABASE_PICKUP_MEMBER_ABSENT");
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
      bannerId: banner?.id ?? null,
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
  actorId: string,
  report: SourceReport,
  baseline: unknown,
  rawInput: unknown,
) {
  const input = bannerIdentityAcceptanceSchema.parse(rawInput);
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
  if (source.heldMappings)
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Source or baseline evidence changed. Review the identity proposal again.",
    });
  const expected = new Map(
    input.bindings.map((binding) => [binding.sourceKey, binding]),
  );
  return database.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actorId} FOR SHARE`;
      await requireCurator(tx, actorId);
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
