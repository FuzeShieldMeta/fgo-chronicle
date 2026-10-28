import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Banner, Prisma, PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import { BANNER_SYNC_LIMITS } from "~/shared/banner-sync-config.mjs";
import {
  JP_BANNER_IDENTITY_LIMITS,
  previewJpBannerIdentityMap,
} from "./jp-banner-identity";
import {
  bannerDatabaseFingerprint,
  bannerIdentityAcceptanceSchema,
  loadBannerIdentityTargets,
} from "./banner-source-identity";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";

type Database = PrismaClient | Prisma.TransactionClient;
type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
const publicationFieldNames = ["NAME", "SOURCE", "TIMING", "ROSTER"] as const;
export const bannerPublicationFieldsSchema = z
  .array(z.enum(publicationFieldNames))
  .min(1)
  .max(publicationFieldNames.length)
  .refine(
    (fields) => new Set(fields).size === fields.length,
    "Duplicate publication field.",
  )
  .transform((fields) => [...fields].sort());
const acceptedBinding = bannerIdentityAcceptanceSchema.shape.bindings.element;
export const bannerPublicationAcceptanceSchema =
  bannerIdentityAcceptanceSchema.extend({
    bindings: z
      .array(
        acceptedBinding.extend({
          fields: bannerPublicationFieldsSchema,
          expectedPublicationRevision: z.number().int().positive().nullable(),
        }),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  });
type Fields = z.infer<typeof bannerPublicationFieldsSchema>;
type Values = Pick<Banner, "name" | "sourceUrl" | "sourceRegion" | "status">;
function ownedValues(values: Values, fields: readonly string[]) {
  return {
    ...(fields.includes("NAME") ? { name: values.name } : {}),
    ...(fields.includes("SOURCE")
      ? {
          sourceUrl: values.sourceUrl,
          sourceRegion: values.sourceRegion,
          status: values.status,
        }
      : {}),
  };
}

async function publicationRows(
  database: Database,
  source: ReturnType<typeof previewJpBannerIdentityMap>,
  selections: Map<string, Fields>,
) {
  const { byKey, byIdentity } = await loadBannerIdentityTargets(
    database,
    source,
  );
  return source.mappings.map((mapping) => {
    const fields = selections.get(mapping.sourceKey)!;
    const issues = [...mapping.issues];
    const banner = byKey.get(mapping.targetSourceKey);
    const identity = byIdentity.get(mapping.sourceKey);
    const ownership = banner?.sourcePublication;
    if (!banner) issues.push("DATABASE_TARGET_NOT_FOUND");
    if (!identity) issues.push("IDENTITY_NOT_REGISTERED");
    if (banner && identity && banner.id !== identity.bannerId)
      issues.push("IDENTITY_TARGET_CONFLICT");
    if (identity && identity.sourceUrl !== mapping.sourceUrl)
      issues.push("REGISTERED_SOURCE_URL_CHANGED");
    if (
      byKey.has(mapping.sourceKey) &&
      byKey.get(mapping.sourceKey)!.id !== banner?.id
    )
      issues.push("DATABASE_BASE_KEY_COLLISION");
    if (
      banner &&
      (banner.status !== "PROJECTED" ||
        banner.sourceRegion !== "JP_PROJECTED" ||
        [banner.dateOverlay?.startStatus, banner.dateOverlay?.endStatus].some(
          (status) => status === "OFFICIAL" || status === "CURATED",
        ))
    )
      issues.push("OFFICIAL_OR_CURATED_TARGET");
    if (ownership && ownership.sourceKey !== mapping.sourceKey)
      issues.push("PUBLICATION_OWNED_BY_ANOTHER_IDENTITY");
    if (
      ownership?.ownedFields.some(
        (field) => !fields.some((selected) => selected === field),
      )
    )
      issues.push("REVIEW_ALL_OWNED_FIELDS");
    if (
      banner &&
      mapping.knownServantIds.some(
        (id) => !banner.featured.some((member) => member.servantId === id),
      )
    )
      issues.push("DATABASE_PICKUP_MEMBER_ABSENT");
    if (
      fields.includes("NAME") &&
      (!mapping.sourceSubject ||
        mapping.sourceSubject.length > BANNER_SYNC_LIMITS.maxTextCharacters)
    )
      issues.push("SOURCE_NAME_UNAVAILABLE");
    // These remain real evidence gates, not caller-supplied approval booleans.
    if (fields.includes("TIMING"))
      issues.push("VERIFIED_FAMILY_PROJECTION_ANCHOR_REQUIRED");
    if (fields.includes("ROSTER"))
      issues.push("COMPLETE_ROSTER_EVIDENCE_REQUIRED");
    const values = ownedValues(
      {
        name: mapping.sourceSubject ?? "",
        sourceUrl: mapping.sourceUrl,
        status: "PROJECTED",
        sourceRegion: "JP_PROJECTED",
      },
      fields,
    );
    const currentValues = banner ? ownedValues(banner, fields) : null;
    const publishedContentHash = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          sourceKey: mapping.sourceKey,
          articleContentHash: mapping.expectedArticleContentHash,
          periodEvidenceHash: mapping.periodEvidenceHash,
          fields,
          values,
        }),
      )
      .digest("hex");
    const unchanged =
      ownership?.publishedContentHash === publishedContentHash &&
      ownership.articleContentHash === mapping.expectedArticleContentHash &&
      ownership.periodEvidenceHash === mapping.periodEvidenceHash &&
      JSON.stringify([...ownership.ownedFields].sort()) ===
        JSON.stringify(fields) &&
      JSON.stringify(currentValues) === JSON.stringify(values);
    return {
      mapping,
      banner,
      ownership,
      fields,
      values,
      currentValues,
      publishedContentHash,
      issues,
      status: issues.length
        ? ("HELD" as const)
        : unchanged
          ? ("UNCHANGED" as const)
          : ("READY_TO_PUBLISH" as const),
      databaseFingerprint: banner ? bannerDatabaseFingerprint(banner) : null,
    };
  });
}

/** Field-level review, with source and DB ownership gates kept separate. */
export async function previewBannerSourcePublication(
  database: Database,
  report: SourceReport,
  baseline: unknown,
  map: unknown,
  rawFields: unknown,
) {
  const fields = bannerPublicationFieldsSchema.parse(rawFields);
  const source = previewJpBannerIdentityMap(report, baseline, map);
  const rows = await publicationRows(
    database,
    source,
    new Map(source.mappings.map((mapping) => [mapping.sourceKey, fields])),
  );
  return {
    scope: "JP_BANNER_FIELD_PUBLICATION_PREVIEW" as const,
    databaseWrites: 0 as const,
    fullBannerPublicationAllowed: false as const,
    mappings: rows.map((row) => ({
      sourceKey: row.mapping.sourceKey,
      bannerId: row.banner?.id ?? null,
      fields: row.fields,
      status: row.status,
      issues: row.issues,
      currentValues: row.currentValues,
      proposedValues: row.values,
      databaseFingerprint: row.databaseFingerprint,
      publicationRevision: row.ownership?.revision ?? null,
      fieldPublicationAllowed: row.status !== "HELD",
    })),
  };
}

/** Accept only selected values derived from current evidence; never insert a banner. */
export async function publishBannerSourceValues(
  database: PrismaClient,
  actorId: string,
  report: SourceReport,
  baseline: unknown,
  rawInput: unknown,
) {
  const input = bannerPublicationAcceptanceSchema.parse(rawInput);
  const map = {
    version: 1,
    mappings: input.bindings.map(
      ({
        bannerId: _id,
        expectedDatabaseFingerprint: _fingerprint,
        fields: _fields,
        expectedPublicationRevision: _revision,
        ...mapping
      }) => mapping,
    ),
  };
  const source = previewJpBannerIdentityMap(report, baseline, map);
  if (source.heldMappings)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Source evidence changed. Review the publication again.",
    });
  const selections = new Map(
    input.bindings.map((binding) => [binding.sourceKey, binding.fields]),
  );
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
      const rows = await publicationRows(tx, source, selections);
      for (const row of rows) {
        const review = expected.get(row.mapping.sourceKey)!;
        if (
          row.status === "HELD" ||
          row.banner?.id !== review.bannerId ||
          (row.status !== "UNCHANGED" &&
            (row.databaseFingerprint !== review.expectedDatabaseFingerprint ||
              (row.ownership?.revision ?? null) !==
                review.expectedPublicationRevision))
        )
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Publication evidence, ownership or banner state changed. Refresh the preview.",
          });
      }
      let published = 0;
      for (const row of rows) {
        if (row.status === "UNCHANGED") continue;
        const banner = row.banner!;
        if (JSON.stringify(row.currentValues) !== JSON.stringify(row.values))
          await tx.banner.update({
            where: { id: banner.id },
            data: row.values,
          });
        const revision = (row.ownership?.revision ?? 0) + 1;
        const data = {
          sourceKey: row.mapping.sourceKey,
          ownedFields: row.fields,
          revision,
          articleContentHash: row.mapping.expectedArticleContentHash,
          periodEvidenceHash: row.mapping.periodEvidenceHash,
          publishedContentHash: row.publishedContentHash,
        };
        await tx.bannerSourcePublication.upsert({
          where: { bannerId: banner.id },
          create: { bannerId: banner.id, ...data },
          update: data,
        });
        await tx.curatorChange.create({
          data: {
            actorId,
            targetKind: "BANNER",
            targetId: banner.id,
            action: "PUBLISH_JP_BANNER_SOURCE",
            reason: input.reason,
            before: {
              values: row.currentValues,
              publicationRevision: row.ownership?.revision ?? null,
            },
            after: {
              values: row.values,
              ...data,
              databaseFingerprint: expected.get(row.mapping.sourceKey)!
                .expectedDatabaseFingerprint,
            },
          },
        });
        published++;
      }
      return { published, unchanged: input.bindings.length - published };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
