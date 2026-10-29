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
import {
  jpBannerFamilyTimingSchema,
  loadJpBannerFamilyTiming,
} from "./jp-banner-family-timing";

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
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timingReviewSchema = z
  .object({
    familyId: z.string().min(1).max(100),
    expectedAnchorRevision: z.number().int().positive().nullable(),
    expectedFactsHash: digest,
    expectedReviewFingerprint: digest,
  })
  .strict();
export const bannerPublicationAcceptanceSchema = bannerIdentityAcceptanceSchema
  .extend({
    familyAnchors: jpBannerFamilyTimingSchema.optional(),
    bindings: z
      .array(
        acceptedBinding.extend({
          fields: bannerPublicationFieldsSchema,
          expectedPublicationRevision: z.number().int().positive().nullable(),
          timing: timingReviewSchema.optional(),
        }),
      )
      .min(1)
      .max(JP_BANNER_IDENTITY_LIMITS.maxMappings),
  })
  .superRefine((input, ctx) => {
    if (
      input.bindings.some(
        (binding) =>
          binding.fields.includes("TIMING") !== Boolean(binding.timing),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Timing publication requires its exact review snapshot.",
      });
    if (
      input.familyAnchors &&
      !input.bindings.some((binding) => binding.fields.includes("TIMING"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Family anchors require timing publication.",
      });
  });
type Fields = z.infer<typeof bannerPublicationFieldsSchema>;
type Values = Pick<Banner, "name" | "sourceUrl" | "sourceRegion" | "status"> &
  Partial<
    Pick<
      Banner,
      "startsAt" | "endsAt" | "startsAtPrecision" | "endsAtPrecision"
    >
  >;
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
    ...(fields.includes("TIMING") && values.startsAt
      ? {
          startsAt: values.startsAt,
          endsAt: values.endsAt ?? null,
          startsAtPrecision: values.startsAtPrecision,
          endsAtPrecision: values.endsAtPrecision ?? null,
        }
      : {}),
  };
}

async function publicationRows(
  database: Database,
  source: ReturnType<typeof previewJpBannerIdentityMap>,
  selections: Map<string, Fields>,
  report: SourceReport,
  rawTimingInput?: unknown,
) {
  const { byKey, byIdentity } = await loadBannerIdentityTargets(
    database,
    source,
  );
  const timing = [...selections.values()].some((fields) =>
    fields.includes("TIMING"),
  )
    ? await loadJpBannerFamilyTiming(
        database,
        report,
        {
          ...source,
          mappings: source.mappings.filter((row) =>
            selections.get(row.sourceKey)?.includes("TIMING"),
          ),
        },
        rawTimingInput,
      )
    : null;
  const byTiming = new Map(timing?.mappings.map((row) => [row.sourceKey, row]));
  const changingFamilies = [
    ...new Set(
      timing?.mappings
        .filter((row) => row.storedAnchor && row.anchorStatus !== "UNCHANGED")
        .flatMap((row) => (row.familyId ? [row.familyId] : [])),
    ),
  ];
  const owners = changingFamilies.length
    ? await database.bannerSourcePublication.findMany({
        where: { timingAnchorFamilyId: { in: changingFamilies } },
        select: {
          sourceKey: true,
          timingAnchorFamilyId: true,
          banner: {
            select: { status: true, sourceRegion: true, dateOverlay: true },
          },
        },
        take: JP_BANNER_IDENTITY_LIMITS.maxMappings + 1,
      })
    : [];
  if (owners.length > JP_BANNER_IDENTITY_LIMITS.maxMappings)
    throw new Error("Family timing ownership limit exceeded.");
  return source.mappings.map((mapping) => {
    const fields = selections.get(mapping.sourceKey)!;
    const issues = [...mapping.issues, ...mapping.registrationHolds];
    const banner = byKey.get(mapping.targetSourceKey);
    const identity = byIdentity.get(mapping.sourceKey);
    const ownership = banner?.sourcePublication;
    const familyTiming = fields.includes("TIMING")
      ? byTiming.get(mapping.sourceKey)
      : undefined;
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
    if (fields.includes("TIMING")) {
      if (!familyTiming)
        issues.push("VERIFIED_FAMILY_PROJECTION_ANCHOR_REQUIRED");
      else {
        if (!familyTiming.anchor || !familyTiming.anchorFactsHash)
          issues.push("VERIFIED_FAMILY_PROJECTION_ANCHOR_REQUIRED");
        issues.push(...familyTiming.issues);
        if (familyTiming.event?.sourceStartsAtPrecision !== "EXACT")
          issues.push("EXACT_JP_ANCHOR_REQUIRED");
        if (!validAnchorSourceUrl(familyTiming.event?.sourceUrl))
          issues.push("ANCHOR_SOURCE_URL_UNAVAILABLE");
        if (
          !familyTiming.projection?.projectedStartsAt ||
          !familyTiming.projection.projectedEndsAt
        )
          issues.push("EXACT_PICKUP_PERIOD_REQUIRED");
        if (
          timing!.mappings.some(
            (other) =>
              other.familyId === familyTiming.familyId &&
              other.anchorFactsHash !== familyTiming.anchorFactsHash,
          )
        )
          issues.push("CONFLICTING_FAMILY_ANCHOR_SELECTION");
        if (
          owners.some(
            (owner) =>
              owner.timingAnchorFamilyId === familyTiming.familyId &&
              owner.banner.status === "PROJECTED" &&
              owner.banner.sourceRegion === "JP_PROJECTED" &&
              ![
                owner.banner.dateOverlay?.startStatus,
                owner.banner.dateOverlay?.endStatus,
              ].some(
                (status) => status === "OFFICIAL" || status === "CURATED",
              ) &&
              !selections.get(owner.sourceKey)?.includes("TIMING"),
          )
        )
          issues.push("REVIEW_ALL_FAMILY_TIMING_OWNERS");
      }
      if (!fields.includes("SOURCE"))
        issues.push("TIMING_SOURCE_PROVENANCE_REQUIRED");
      if (banner?.summonLineups.length)
        issues.push("LINEUP_TIMING_REVIEW_REQUIRED");
      if (banner?.dateOverlay)
        issues.push("EXISTING_DATE_OVERLAY_REQUIRES_REVIEW");
      if (
        ownership?.ownedFields.includes("TIMING") &&
        ownership.timingAnchorFamilyId !== banner?.familyId
      )
        issues.push("TIMING_ANCHOR_FAMILY_CHANGED");
    }
    if (fields.includes("ROSTER"))
      issues.push("COMPLETE_ROSTER_EVIDENCE_REQUIRED");
    const values = ownedValues(
      {
        name: mapping.sourceSubject ?? "",
        sourceUrl: mapping.sourceUrl,
        status: "PROJECTED",
        sourceRegion: "JP_PROJECTED",
        startsAt: familyTiming?.projection?.projectedStartsAt
          ? new Date(familyTiming.projection.projectedStartsAt)
          : undefined,
        endsAt: familyTiming?.projection?.projectedEndsAt
          ? new Date(familyTiming.projection.projectedEndsAt)
          : null,
        startsAtPrecision: "EXACT",
        endsAtPrecision: "EXACT",
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
          ...(familyTiming
            ? {
                timingAnchor: {
                  familyId: familyTiming.familyId,
                  factsHash: familyTiming.anchorFactsHash,
                  revision: familyTiming.proposedAnchorRevision,
                },
              }
            : {}),
        }),
      )
      .digest("hex");
    const unchanged =
      ownership?.publishedContentHash === publishedContentHash &&
      ownership.articleContentHash === mapping.expectedArticleContentHash &&
      ownership.periodEvidenceHash === mapping.periodEvidenceHash &&
      JSON.stringify([...ownership.ownedFields].sort()) ===
        JSON.stringify(fields) &&
      JSON.stringify(currentValues) === JSON.stringify(values) &&
      (!familyTiming ||
        (familyTiming.anchorStatus === "UNCHANGED" &&
          ownership.timingAnchorFamilyId === familyTiming.familyId &&
          ownership.timingAnchorRevision ===
            familyTiming.proposedAnchorRevision));
    return {
      mapping,
      banner,
      ownership,
      familyTiming,
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
  rawTimingInput?: unknown,
) {
  const fields = bannerPublicationFieldsSchema.parse(rawFields);
  const source = previewJpBannerIdentityMap(report, baseline, map);
  const rows = await publicationRows(
    database,
    source,
    new Map(source.mappings.map((mapping) => [mapping.sourceKey, fields])),
    report,
    rawTimingInput,
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
      ...(row.familyTiming
        ? {
            timing: {
              familyId: row.familyTiming.familyId,
              expectedAnchorRevision:
                row.familyTiming.storedAnchor?.revision ?? null,
              expectedFactsHash: row.familyTiming.anchorFactsHash,
              expectedReviewFingerprint: row.familyTiming.reviewFingerprint,
            },
            anchorStatus: row.familyTiming.anchorStatus,
          }
        : {}),
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
        timing: _timing,
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
      if (input.bindings.some((binding) => binding.fields.includes("TIMING"))) {
        const families = [
          ...new Set(
            input.bindings.flatMap((binding) =>
              binding.timing ? [binding.timing.familyId] : [],
            ),
          ),
        ].sort();
        await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(families)}::jsonb)) ORDER BY "id" FOR UPDATE`;
        const initial = await loadJpBannerFamilyTiming(
          tx,
          report,
          {
            ...source,
            mappings: source.mappings.filter((row) =>
              selections.get(row.sourceKey)?.includes("TIMING"),
            ),
          },
          input.familyAnchors,
        );
        const eventIds = [
          ...new Set(
            initial.mappings.flatMap((row) =>
              row.anchorEventId ? [row.anchorEventId] : [],
            ),
          ),
        ].sort();
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(eventIds)}::jsonb)) ORDER BY "id" FOR UPDATE`;
      }
      const ids = [
        ...new Set(input.bindings.map((binding) => binding.bannerId)),
      ].sort();
      await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY "id" FOR UPDATE`;
      const rows = await publicationRows(
        tx,
        source,
        selections,
        report,
        input.familyAnchors,
      );
      for (const row of rows) {
        const review = expected.get(row.mapping.sourceKey)!;
        if (
          row.status === "HELD" ||
          row.banner?.id !== review.bannerId ||
          (row.familyTiming &&
            (row.familyTiming.familyId !== review.timing?.familyId ||
              row.familyTiming.anchorFactsHash !==
                review.timing.expectedFactsHash)) ||
          (row.status !== "UNCHANGED" &&
            (row.databaseFingerprint !== review.expectedDatabaseFingerprint ||
              (row.ownership?.revision ?? null) !==
                review.expectedPublicationRevision ||
              (row.familyTiming &&
                (row.familyTiming.reviewFingerprint !==
                  review.timing?.expectedReviewFingerprint ||
                  (row.familyTiming.storedAnchor?.revision ?? null) !==
                    review.timing?.expectedAnchorRevision))))
        )
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Publication evidence, ownership or banner state changed. Refresh the preview.",
          });
      }
      let published = 0;
      const acceptedFamilies = new Set<string>();
      for (const row of rows) {
        if (row.status === "UNCHANGED") continue;
        const banner = row.banner!;
        const timing = row.familyTiming;
        if (timing && !acceptedFamilies.has(timing.familyId!)) {
          acceptedFamilies.add(timing.familyId!);
          if (timing.anchorStatus !== "UNCHANGED") {
            const data = {
              anchorEventId: timing.anchorEventId!,
              jpResetDay: new Date(`${timing.anchor!.jpResetDay}T00:00:00Z`),
              naResetDay: new Date(`${timing.anchor!.naResetDay}T00:00:00Z`),
              factsHash: timing.anchorFactsHash!,
              sourceUrl: timing.event!.sourceUrl!,
              sourceContentHash: timing.event!.sourceContentHash,
              revision: timing.proposedAnchorRevision,
            };
            await tx.bannerFamilyTimingAnchor.upsert({
              where: { familyId: timing.familyId! },
              create: { familyId: timing.familyId!, ...data },
              update: data,
            });
            await tx.curatorChange.create({
              data: {
                actorId,
                targetKind: "FAMILY",
                targetId: timing.familyId!,
                action: "ACCEPT_BANNER_FAMILY_TIMING",
                reason: input.reason,
                before: {
                  revision: timing.storedAnchor?.revision ?? null,
                  factsHash: timing.storedAnchor?.factsHash ?? null,
                },
                after: {
                  ...data,
                  jpResetDay: data.jpResetDay.toISOString(),
                  naResetDay: data.naResetDay.toISOString(),
                  reviewFingerprint: timing.reviewFingerprint,
                },
              },
            });
          }
        }
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
          timingAnchorFamilyId: timing?.familyId ?? null,
          timingAnchorRevision: timing?.proposedAnchorRevision ?? null,
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
            before: auditJson({
              values: row.currentValues,
              publicationRevision: row.ownership?.revision ?? null,
            }),
            after: auditJson({
              values: row.values,
              ...data,
              databaseFingerprint: expected.get(row.mapping.sourceKey)!
                .expectedDatabaseFingerprint,
            }),
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

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function validAnchorSourceUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
