import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  GLOBAL_BANNER_PUBLICATION_LIMITS as LIMITS,
  GLOBAL_SOURCE_LIMITS,
  SERVANT_CATALOGUE_LIMITS,
  SERVANT_RARITY_BY_LABEL,
} from "~/shared/global-reconciliation-config";
import { BANNER_SYNC_LIMITS } from "~/shared/banner-sync-config.mjs";
import { bannerIdentitySnapshotInclude } from "./banner-source-identity";
import { importBannerDataset } from "./banner-import";
import { bannerDatasetSchema } from "./banner-dataset";
import { lockSourcePublicationAuthority } from "./global-source-authority";
import { effectiveBanner, eventIsHidden } from "./effective-schedule";
import { announcementEventTypes } from "./global-announcement-match";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import {
  publisherArticleUrl,
  type parsePublisherAnnouncement,
} from "./global-announcement-parser";
import {
  bindGlobalSummonCatalogue,
  resolveGlobalSummonServants,
  type GlobalSummonCatalogue,
} from "./global-summon-servants";

type Article = ReturnType<typeof parsePublisherAnnouncement>;
const campaignPeriodSchema = z.object({
  kind: z.enum(["CAMPAIGN", "EVENT", "QUEST"]),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  issues: z.array(z.string()).length(0),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(LIMITS.maxIdentifierCharacters);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = z
  .object({
    sourceKey: z
      .string()
      .max(BANNER_SYNC_LIMITS.maxTextCharacters)
      .regex(/^publisher:NA:pickup:[a-z0-9][a-z0-9_-]*$/u),
    sectionEvidenceHash: digest,
    rosterEvidenceHash: digest,
    completeRoster: z.boolean(),
    standardRates: z.boolean(),
  })
  .strict();
export const globalBannerReviewSchema = z
  .object({
    version: z.literal(1),
    sourceUrl: z.url().refine((value) => {
      try {
        return publisherArticleUrl(value) === value;
      } catch {
        return false;
      }
    }),
    expectedArticleContentHash: digest,
    eventId: id,
    campaignCandidateId: id,
    acknowledgeUnparsedContexts: z.boolean(),
    bindings: z.array(binding).min(1).max(LIMITS.maxBindings),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.bindings.map((row) => row.sourceKey)).size !==
        input.bindings.length ||
      new Set(input.bindings.map((row) => row.sectionEvidenceHash)).size !==
        input.bindings.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate source binding or pickup section.",
      });
  });
export const globalBannerAcceptanceSchema = globalBannerReviewSchema.safeExtend(
  {
    reason: z
      .string()
      .trim()
      .min(GLOBAL_SOURCE_LIMITS.minPublicationReasonLength)
      .max(GLOBAL_SOURCE_LIMITS.maxPublicationReasonLength),
    expectedDatabaseFingerprint: digest,
  },
);
type Review = z.infer<typeof globalBannerReviewSchema>;
const include = {
  ...bannerIdentitySnapshotInclude,
  sourceIdentities: { orderBy: { sourceKey: "asc" } },
} satisfies Prisma.BannerInclude;
const ownedFields = ["NAME", "ROSTER", "SOURCE", "TIMING"];

type Database = Prisma.TransactionClient;
async function publicationPlan(
  tx: Database,
  article: Article,
  catalogue: GlobalSummonCatalogue,
  review: Review,
) {
  if (!catalogue.size || catalogue.size > SERVANT_CATALOGUE_LIMITS.maxRecords)
    throw new Error("Global servant catalogue exceeds its limit.");
  const event = await tx.event.findUnique({
    where: { id: review.eventId },
    include: {
      curation: true,
      globalBaseline: true,
      dateOverlay: true,
      family: { include: { curation: true } },
    },
  });
  const [stored, candidate, aliases, targets] = await Promise.all([
    tx.servant.findMany({
      select: {
        id: true,
        name: true,
        className: true,
        rarity: true,
        atlasNaAvailable: true,
      },
      orderBy: { id: "asc" },
      take: SERVANT_CATALOGUE_LIMITS.maxRecords + 1,
    }),
    tx.globalEventCandidate.findUnique({
      where: { id: review.campaignCandidateId },
    }),
    tx.globalEventCandidate.findMany({
      where: { sourceKind: "GLOBAL_GAME_DATA", targetEventId: review.eventId },
      distinct: ["sourceRecordId"],
      orderBy: [
        { sourceRecordId: "asc" },
        { retrievedAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
    }),
    tx.banner.findMany({
      where: {
        OR: [
          { sourceKey: { in: review.bindings.map((row) => row.sourceKey) } },
          {
            sourceIdentities: {
              some: {
                OR: [
                  { sourceUrl: review.sourceUrl },
                  {
                    sourceKey: {
                      in: review.bindings.map((row) => row.sourceKey),
                    },
                  },
                ],
              },
            },
          },
          { sourceUrl: review.sourceUrl },
          ...(event?.familyId ? [{ familyId: event.familyId }] : []),
          {
            featured: {
              some: {
                servantId: {
                  in: [...catalogue.keys()],
                },
              },
            },
          },
        ],
      },
      include,
      orderBy: { id: "asc" },
      take: LIMITS.maxTargets + 1,
    }),
  ]);
  if (
    stored.length > SERVANT_CATALOGUE_LIMITS.maxRecords ||
    targets.length > LIMITS.maxTargets ||
    aliases.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords
  )
    throw new Error("Global banner publication inventory exceeds its limit.");
  const sections = resolveGlobalSummonServants(
    article.summonSections ?? [],
    bindGlobalSummonCatalogue(stored, catalogue),
  );
  const names = [
    ...new Set(
      event
        ? aliases.flatMap((row) => {
            const name = verifiedAtlasAlias(row, event);
            return name ? [name] : [];
          })
        : [],
    ),
  ];
  const commonIssues: string[] = [];
  if (
    article.sourceUrl !== review.sourceUrl ||
    article.contentHash !== `sha256:${review.expectedArticleContentHash}`
  )
    commonIssues.push("ARTICLE_EVIDENCE_CHANGED");
  if (
    article.issues.some((issue) => issue !== "UNEXTRACTED_DATE_CONTEXT") ||
    (article.unsupportedDateContexts.length &&
      !review.acknowledgeUnparsedContexts)
  )
    commonIssues.push("ARTICLE_REVIEW_REQUIRED");
  const overlay = event?.dateOverlay;
  const baseline = event?.globalBaseline;
  const campaignPeriod = campaignPeriodSchema.safeParse(candidate?.snapshot);
  const candidateWindowMatches =
    campaignPeriod.success &&
    candidate?.startsAt?.toISOString() === campaignPeriod.data.startsAt &&
    (candidate?.endsAt?.toISOString() ?? null) === campaignPeriod.data.endsAt &&
    event &&
    announcementEventTypes[campaignPeriod.data.kind]?.includes(event.type);
  const officialAnchor =
    event &&
    candidate?.sourceKind === "PUBLISHER_ANNOUNCEMENT" &&
    candidateWindowMatches &&
    ((overlay?.candidateId === candidate.id &&
      overlay.anchorEventId === event.id &&
      overlay.startStatus === "OFFICIAL" &&
      overlay.endStatus === "OFFICIAL" &&
      overlay.startsAt.toISOString() === campaignPeriod.data.startsAt &&
      (overlay.endsAt?.toISOString() ?? null) === campaignPeriod.data.endsAt) ||
      (baseline?.candidateId === candidate.id &&
        baseline.startsAt.toISOString() === campaignPeriod.data.startsAt &&
        (baseline.endsAt?.toISOString() ?? null) ===
          campaignPeriod.data.endsAt));
  if (
    !officialAnchor ||
    !event?.familyId ||
    eventIsHidden(event) ||
    names.length !== 1 ||
    !candidate ||
    (candidate.sourceUrl !== article.sourceUrl &&
      !article.relatedArticleUrls?.includes(candidate.sourceUrl))
  )
    commonIssues.push("VERIFIED_GLOBAL_FAMILY_REQUIRED");
  const rows = review.bindings.map((selected) => {
    const issues = [...commonIssues];
    const matched = sections.filter(
      (section) => section.evidenceHash === selected.sectionEvidenceHash,
    );
    const section = matched.length === 1 ? matched[0] : undefined;
    if (
      section?.rosterProposal.evidenceHash !== selected.rosterEvidenceHash ||
      section.rosterProposal.status === "HELD"
    )
      issues.push("ROSTER_EVIDENCE_CHANGED_OR_HELD");
    if (!selected.completeRoster || !selected.standardRates)
      issues.push("ROSTER_REVIEW_REQUIRED");
    const name = `${names[0] ?? ""}: ${section?.rawServants.map((member) => member.name).join(" / ") ?? ""}`;
    const proposed =
      section?.startsAt && section.endsAt && event?.familyId
        ? {
            name,
            sourceKey: selected.sourceKey,
            sourceUrl: review.sourceUrl,
            startsAt: section.startsAt,
            endsAt: section.endsAt,
            timePrecision: "EXACT" as const,
            status: "OFFICIAL" as const,
            sourceSchedule: "NA" as const,
            servants: section.rosterProposal.featured.map((member) => {
              const identity = stored.find(
                (row) => row.id === member.servantId,
              )!;
              return {
                id: member.servantId,
                name: identity.name,
                class: identity.className,
                rarity: member.rarity,
                soloRateUp: member.soloRateUp,
              };
            }),
          }
        : null;
    const publicValues = proposed
      ? {
          name: proposed.name,
          sourceUrl: proposed.sourceUrl,
          startsAt: proposed.startsAt,
          endsAt: proposed.endsAt,
          startsAtPrecision: "EXACT",
          endsAtPrecision: "EXACT",
          status: "OFFICIAL",
          sourceRegion: "NA",
          familyId: event!.familyId,
          featured: proposed.servants.map((member) => ({
            servantId: member.id,
            soloRateUp: member.soloRateUp,
          })),
        }
      : null;
    const publishedContentHash = hash(publicValues);
    if (
      !proposed ||
      !bannerDatasetSchema.safeParse({ banners: [proposed] }).success
    )
      issues.push("INVALID_PROPOSED_BANNER");
    const existing = targets.filter(
      (target) =>
        target.sourceKey === selected.sourceKey ||
        target.sourceIdentities.some(
          (identity) => identity.sourceKey === selected.sourceKey,
        ),
    );
    const current = existing.length === 1 ? existing[0] : null;
    let unchanged = false;
    if (current && publicValues) {
      const identity = current.sourceIdentities.find(
        (row) => row.sourceKey === selected.sourceKey,
      );
      const values = {
        name: current.name,
        sourceUrl: current.sourceUrl,
        startsAt: current.startsAt.toISOString(),
        endsAt: current.endsAt?.toISOString() ?? null,
        startsAtPrecision: current.startsAtPrecision,
        endsAtPrecision: current.endsAtPrecision,
        status: current.status,
        sourceRegion: current.sourceRegion,
        familyId: current.familyId,
        featured: current.featured.map((member) => ({
          servantId: member.servantId,
          soloRateUp: member.soloRateUp,
        })),
      };
      unchanged =
        current.sourceKey === selected.sourceKey &&
        !current.hidden &&
        !current.summonLineups.length &&
        !current.dateOverlay &&
        identity?.sourceUrl === review.sourceUrl &&
        identity.articleContentHash === review.expectedArticleContentHash &&
        identity.periodEvidenceHash === selected.sectionEvidenceHash &&
        current.sourcePublication?.sourceKey === selected.sourceKey &&
        current.sourcePublication.publishedContentHash ===
          publishedContentHash &&
        JSON.stringify(current.sourcePublication.ownedFields) ===
          JSON.stringify(ownedFields) &&
        hash(values) === publishedContentHash;
    }
    if (existing.length && !unchanged)
      issues.push("EXISTING_IDENTITY_REQUIRES_REVIEW");
    const candidateIds = targets
      .filter((target) => {
        if (existing.includes(target)) return false;
        if (
          target.sourceIdentities.some(
            (identity) =>
              identity.sourceUrl === review.sourceUrl &&
              identity.periodEvidenceHash === selected.sectionEvidenceHash,
          )
        )
          return true;
        const sameRoster =
          JSON.stringify(target.featured.map((member) => member.servantId)) ===
          JSON.stringify(
            section?.rosterProposal.featured.map((member) => member.servantId),
          );
        const sameFamily = target.familyId === event?.familyId;
        const sameNotice =
          target.sourceUrl === review.sourceUrl ||
          target.sourceIdentities.some(
            (identity) => identity.sourceUrl === review.sourceUrl,
          );
        const effective = effectiveBanner(target);
        const overlaps =
          section?.startsAt &&
          section.endsAt &&
          effective.startsAt.getTime() <= Date.parse(section.endsAt) &&
          (!effective.endsAt ||
            effective.endsAt.getTime() >= Date.parse(section.startsAt));
        const sameSsr = section?.rosterProposal.featured.some(
          (source) =>
            source.rarity === SERVANT_RARITY_BY_LABEL.ssr &&
            target.featured.some(
              (member) => member.servantId === source.servantId,
            ),
        );
        return (
          (sameRoster && (sameFamily || sameNotice || Boolean(overlaps))) ||
          (Boolean(sameSsr) && (sameFamily || sameNotice))
        );
      })
      .map((target) => target.id);
    if (candidateIds.length) issues.push("POSSIBLE_EXISTING_BANNER");
    return {
      selected,
      sourceSectionId: section?.sourceSectionId ?? null,
      rosterProposal: section?.rosterProposal ?? null,
      issues: [...new Set(issues)],
      status: issues.length
        ? ("HELD" as const)
        : unchanged
          ? ("UNCHANGED" as const)
          : ("READY_TO_CREATE" as const),
      proposed,
      publicValues,
      publishedContentHash,
      candidateIds,
      bannerId: current?.id ?? null,
      familyId: event?.familyId ?? null,
    };
  });
  const databaseFingerprint = hash({
    review,
    rows: rows.map((row) => ({
      sourceKey: row.selected.sourceKey,
      publicValues: row.publicValues,
      issues: row.issues,
    })),
    event: event
      ? {
          id: event.id,
          sourceKey: event.sourceKey,
          familyId: event.familyId,
          curation: event.curation,
          dateOverlay: overlay
            ? { ...overlay, retrievedAt: undefined, updatedAt: undefined }
            : null,
          baseline: baseline
            ? { ...baseline, retrievedAt: undefined, updatedAt: undefined }
            : null,
          familyCuration: event.family?.curation,
        }
      : null,
    candidate: candidate
      ? {
          id: candidate.id,
          contentHash: candidate.contentHash,
          assessmentHash: candidate.assessmentHash,
          sourceUrl: candidate.sourceUrl,
        }
      : null,
    targets,
  });
  return {
    rows,
    databaseFingerprint,
    unsupportedDateContexts: article.unsupportedDateContexts,
  };
}

export async function previewGlobalBannerPublication(
  database: PrismaClient,
  article: Article,
  catalogue: GlobalSummonCatalogue,
  rawReview: unknown,
) {
  const review = globalBannerReviewSchema.parse(rawReview);
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const plan = await publicationPlan(tx, article, catalogue, review);
      return {
        scope: "GLOBAL_BANNER_PUBLICATION_PREVIEW" as const,
        databaseWrites: 0,
        ...plan,
      };
    },
    {
      isolationLevel: "RepeatableRead",
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}

export async function publishGlobalBannerSources(
  database: PrismaClient,
  actorId: string,
  article: Article,
  catalogue: GlobalSummonCatalogue,
  rawAcceptance: unknown,
) {
  const { reason, expectedDatabaseFingerprint, ...review } =
    globalBannerAcceptanceSchema.parse(rawAcceptance);
  const initial = await previewGlobalBannerPublication(
    database,
    article,
    catalogue,
    review,
  );
  if (initial.rows.some((row) => row.status === "HELD"))
    throw new TRPCError({
      code: "CONFLICT",
      message: "Global banner source or target is held. Refresh the preview.",
    });
  const dataset = {
    banners: initial.rows.flatMap((row) =>
      row.status === "READY_TO_CREATE" && row.proposed ? [row.proposed] : [],
    ),
  };
  if (!dataset.banners.length) {
    return database.$transaction(
      async (tx) => {
        await lockSourcePublicationAuthority(tx, actorId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
        const plan = await publicationPlan(tx, article, catalogue, review);
        if (plan.rows.some((row) => row.status !== "UNCHANGED"))
          throw new TRPCError({
            code: "CONFLICT",
            message: "Global banner state changed. Refresh the preview.",
          });
        return { created: 0, unchanged: plan.rows.length };
      },
      {
        maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
        timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
      },
    );
  }
  await importBannerDataset(
    database,
    dataset,
    (tx) => lockSourcePublicationAuthority(tx, actorId),
    {
      beforeWrite: async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" IN (SELECT "familyId" FROM "Event" WHERE "id"=${review.eventId}) FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id"=${review.eventId} FOR UPDATE`;
        const ids = dataset.banners
          .flatMap((banner) => banner.servants.map((member) => member.id))
          .sort((a, b) => a - b);
        await tx.$queryRaw`SELECT "id" FROM "Servant" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::integer) ORDER BY "id" FOR SHARE`;
        const checked = await publicationPlan(tx, article, catalogue, review);
        if (
          checked.databaseFingerprint !== expectedDatabaseFingerprint ||
          checked.databaseFingerprint !== initial.databaseFingerprint ||
          checked.rows.some((row) => row.status === "HELD")
        )
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Global banner evidence or database state changed. Refresh the preview.",
          });
      },
      afterWrite: async (tx) => {
        const created = initial.rows.filter(
          (row) => row.status === "READY_TO_CREATE",
        );
        const banners = await tx.banner.findMany({
          where: {
            sourceKey: { in: created.map((row) => row.selected.sourceKey) },
          },
          select: { id: true, sourceKey: true },
        });
        if (banners.length !== created.length)
          throw new Error("Created banner set differs from its review.");
        await tx.banner.updateMany({
          where: { id: { in: banners.map((row) => row.id) } },
          data: { familyId: created[0]!.familyId },
        });
        await tx.bannerSourceIdentity.createMany({
          data: created.map((row) => ({
            sourceKey: row.selected.sourceKey,
            bannerId: banners.find(
              (b) => b.sourceKey === row.selected.sourceKey,
            )!.id,
            sourceUrl: review.sourceUrl,
            articleContentHash: review.expectedArticleContentHash,
            periodEvidenceHash: row.selected.sectionEvidenceHash,
          })),
        });
        await tx.bannerSourcePublication.createMany({
          data: created.map((row) => ({
            bannerId: banners.find(
              (b) => b.sourceKey === row.selected.sourceKey,
            )!.id,
            sourceKey: row.selected.sourceKey,
            ownedFields,
            articleContentHash: review.expectedArticleContentHash,
            periodEvidenceHash: row.selected.sectionEvidenceHash,
            publishedContentHash: row.publishedContentHash,
          })),
        });
        await tx.curatorChange.createMany({
          data: created.map((row) => ({
            actorId,
            targetKind: "BANNER",
            targetId: banners.find(
              (b) => b.sourceKey === row.selected.sourceKey,
            )!.id,
            action: "PUBLISH_GLOBAL_BANNER_SOURCE",
            reason,
            before: { exists: false },
            after: JSON.parse(
              JSON.stringify({
                sourceKey: row.selected.sourceKey,
                values: row.publicValues,
                articleContentHash: review.expectedArticleContentHash,
                sectionEvidenceHash: row.selected.sectionEvidenceHash,
                rosterEvidenceHash: row.selected.rosterEvidenceHash,
                completeRoster: true,
                standardRates: true,
                databaseFingerprint: initial.databaseFingerprint,
              }),
            ) as Prisma.InputJsonValue,
          })),
        });
      },
    },
  );
  return {
    created: dataset.banners.length,
    unchanged: initial.rows.length - dataset.banners.length,
  };
}
