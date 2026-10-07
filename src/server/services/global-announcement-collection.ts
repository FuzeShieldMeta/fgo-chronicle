import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  curatorSourceAuthority,
  requireSourceAuthority,
  lockSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import {
  GLOBAL_ANNOUNCEMENT_LIMITS,
  GLOBAL_ANNOUNCEMENT_MATCHING,
  GLOBAL_SOURCE_LIMITS,
  MILLISECONDS_PER_DAY,
  IMPORT_EXECUTION_LIMITS,
} from "~/shared/global-reconciliation-config";
import { loadPublisherAnnouncements } from "./global-announcement-source";
import {
  assessAnnouncementArticle,
  announcementEventTypes,
  announcementMatchTypes,
  type AnnouncementMatchEvent,
} from "./global-announcement-match";
import { effectiveEvent } from "./effective-schedule";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import {
  loadRegionalCampaignProofs,
  verifiedRegionalCampaignAlias,
  type CampaignIdentityProof,
} from "./global-campaign-identity";
import { publishAnnouncementFamily } from "./global-announcement-publication";
import { associateBannerFamilies } from "./banner-family-association";
import { publishOfficialBannerDates } from "./official-banner-dates";
import {
  createImportProgress,
  isImportTransactionConflict,
  type ImportProgress,
} from "./import-progress";
import {
  publicEventGlobalBaselineSelect,
  publicDateEvidenceSelect,
  publicEventDateOverlaySelect,
} from "./global-baseline-select";

export const collectAnnouncementsSchema = z.object({}).strict();
type Report = Awaited<ReturnType<typeof loadPublisherAnnouncements>>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function announcementCandidateRows(
  report: Report,
  events?: readonly AnnouncementMatchEvent[],
  regionalProofs: ReadonlyMap<string, CampaignIdentityProof> = new Map(),
): Prisma.GlobalEventCandidateCreateManyInput[] {
  return report.articles.flatMap((article) => {
    const matches = events ? assessAnnouncementArticle(article, events) : null;
    const shared = {
      sourceKind: article.sourceKind,
      sourceUrl: article.sourceUrl,
      retrievedAt: new Date(article.retrievedAt),
      contentHash: article.contentHash,
      name: article.name || article.sourceRecordId,
      targetEventId: null,
    };
    const rows = article.periods.map((period, index) => {
      const invalidRange = period.issues.includes("INVALID_DATE_RANGE");
      const targetId = matches?.[index]?.targetEventId;
      const snapshot = {
        ...period,
        articleName: article.name,
        parserRevision: GLOBAL_ANNOUNCEMENT_LIMITS.parserRevision,
        targetEventId: null,
        ...(matches ? { matching: matches[index] } : {}),
        ...(targetId && regionalProofs.has(targetId)
          ? {
              regionalIdentity: regionalProofs.get(targetId),
            }
          : {}),
      };
      return {
        ...shared,
        sourceRecordId: period.sourceRecordId,
        startsAt:
          invalidRange || !period.startsAt ? null : new Date(period.startsAt),
        endsAt: invalidRange || !period.endsAt ? null : new Date(period.endsAt),
        reasons: ["ANNOUNCEMENT_REQUIRES_REVIEW", ...period.issues],
        assessmentHash: hash(snapshot),
        snapshot: json(snapshot),
      };
    });
    if (article.issues.length) {
      // Keep unsupported contexts separate so one article cannot exceed the snapshot limit.
      const contexts = article.unsupportedDateContexts.length
        ? article.unsupportedDateContexts
        : [""];
      for (const [index, context] of contexts.entries()) {
        const snapshot = {
          articleName: article.name,
          context,
          issues: article.issues,
          parserRevision: GLOBAL_ANNOUNCEMENT_LIMITS.parserRevision,
          publicationAllowed: false,
          targetEventId: null,
        };
        rows.push({
          ...shared,
          sourceRecordId: `${article.sourceRecordId}:issue:${index}`,
          startsAt: null,
          endsAt: null,
          reasons: ["ANNOUNCEMENT_REQUIRES_REVIEW", ...article.issues],
          assessmentHash: hash(snapshot),
          snapshot: json(snapshot),
        });
      }
    }
    return rows;
  });
}

export async function collectAnnouncements(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
  dependencies: Parameters<typeof loadPublisherAnnouncements>[0] = {},
) {
  return collectAnnouncementsWithAuthority(
    database,
    curatorSourceAuthority(actorId),
    rawInput,
    dependencies,
  );
}

export async function collectAnnouncementsWithAuthority(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  rawInput: unknown,
  dependencies: Parameters<typeof loadPublisherAnnouncements>[0] = {},
  execution: {
    dryRun?: boolean;
    allowPublication?: boolean;
    progress?: ImportProgress;
  } = {},
) {
  collectAnnouncementsSchema.parse(rawInput);
  await requireSourceAuthority(database, authority);
  const progress = execution.progress ?? createImportProgress();
  const report = await progress.stage("publisher_download", () =>
    loadPublisherAnnouncements(dependencies),
  );
  const records = announcementCandidateRows(report);
  const starts = report.articles.flatMap((article) =>
    article.periods.flatMap((period) =>
      announcementEventTypes[period.kind] &&
      period.startsAt &&
      Number.isFinite(Date.parse(period.startsAt))
        ? [Date.parse(period.startsAt)]
        : [],
    ),
  );
  const margin =
    GLOBAL_ANNOUNCEMENT_MATCHING.windowDays.at(-1)! * MILLISECONDS_PER_DAY;
  const range = starts.length
    ? {
        gte: new Date(Math.min(...starts) - margin),
        lte: new Date(Math.max(...starts) + margin),
      }
    : null;
  const regionalProofs = new Map<string, CampaignIdentityProof>();
  let regionalCoverageLimited = false;
  if (range && execution.allowPublication !== false) {
    const targets = await database.event.findMany({
      where: {
        sourceKey: { startsWith: "fandom:JP:page:" },
        type: { in: ["CAMPAIGN", "PRE_RELEASE_CAMPAIGN"] },
        OR: [
          { startsAt: range },
          { globalBaseline: { is: { startsAt: range } } },
          { dateOverlay: { is: { startsAt: range } } },
          { curation: { is: { active: true, startsAt: range } } },
        ],
      },
      select: {
        id: true,
        sourceKey: true,
        sourceRegion: true,
        type: true,
        sourceStartsAt: true,
        sourceEndsAt: true,
      },
      take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
    });
    try {
      const proofs = await progress.stage("campaign_identities", () =>
        loadRegionalCampaignProofs(targets, dependencies.fetchFn),
      );
      for (const target of targets) {
        const proof = proofs.get(target.sourceKey);
        if (proof && verifiedRegionalCampaignAlias(proof, target))
          regionalProofs.set(target.id, proof);
      }
    } catch {
      // Never fall back to a stored regional alias after a failed source fetch.
      console.warn(
        JSON.stringify({ event: "campaign_identity_collection_failed" }),
      );
      regionalCoverageLimited = true;
    }
  }
  if (
    records.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords ||
    records.some(
      (record) =>
        Buffer.byteLength(JSON.stringify(record.snapshot), "utf8") >
        GLOBAL_SOURCE_LIMITS.maxSnapshotBytes,
    )
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The publisher assessment exceeds the collection limit. No records were saved.",
    });
  const collect = () =>
    database.$transaction(
      async (tx) => {
        progress.event("publisher_assessments", "transaction_acquired");
        await lockSourceAuthority(tx, authority);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
        if (!execution.dryRun && execution.allowPublication !== false)
          await progress.stage("banner_association", () =>
            associateBannerFamilies(tx, authority.actorId),
          );
        const starts = report.articles.flatMap((article) =>
          article.periods.flatMap((period) => {
            const start = period.startsAt
              ? new Date(period.startsAt).getTime()
              : NaN;
            return announcementEventTypes[period.kind] && Number.isFinite(start)
              ? [start]
              : [];
          }),
        );
        let events: AnnouncementMatchEvent[] = [];
        if (starts.length) {
          events = await progress.stage("publisher_matching", async () => {
            const margin =
              GLOBAL_ANNOUNCEMENT_MATCHING.windowDays.at(-1)! *
              MILLISECONDS_PER_DAY;
            const range = {
              gte: new Date(Math.min(...starts) - margin),
              lte: new Date(Math.max(...starts) + margin),
            };
            const candidates = await tx.event.findMany({
              relationLoadStrategy: "join",
              where: {
                type: { in: announcementMatchTypes },
                OR: [
                  { startsAt: range },
                  { globalBaseline: { is: { startsAt: range } } },
                  { dateOverlay: { is: { startsAt: range } } },
                  { curation: { is: { active: true, startsAt: range } } },
                ],
              },
              select: {
                id: true,
                sourceKey: true,
                sourceRegion: true,
                name: true,
                type: true,
                startsAt: true,
                endsAt: true,
                startsAtPrecision: true,
                endsAtPrecision: true,
                status: true,
                updatedAt: true,
                sourceStartsAt: true,
                sourceEndsAt: true,
                curation: true,
                globalBaseline: publicEventGlobalBaselineSelect,
                dateEvidence: publicDateEvidenceSelect,
                dateOverlay: publicEventDateOverlaySelect,
              },
              orderBy: { id: "asc" },
              take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
            });
            if (candidates.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords)
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  "The announcement matching range contains too many events. No records were saved.",
              });
            const sourceIds = candidates.flatMap((event) => {
              const match = /^atlas:JP:event:(\d+):projection:NA$/.exec(
                event.sourceKey,
              );
              return match ? [match[1]!] : [];
            });
            const aliases = sourceIds.length
              ? await tx.globalEventCandidate.findMany({
                  where: {
                    sourceKind: "GLOBAL_GAME_DATA",
                    sourceRecordId: { in: sourceIds },
                  },
                  distinct: ["sourceRecordId"],
                  orderBy: [
                    { sourceRecordId: "asc" },
                    { retrievedAt: "desc" },
                    { createdAt: "desc" },
                    { id: "desc" },
                  ],
                })
              : [];
            return candidates.map((event) => {
              const effective = effectiveEvent(event);
              const assessment = aliases.find(
                (alias) => alias.targetEventId === event.id,
              );
              const alias =
                execution.allowPublication !== false && assessment
                  ? verifiedAtlasAlias(assessment, event)
                  : null;
              const regional = verifiedRegionalCampaignAlias(
                regionalProofs.get(event.id),
                event,
              );
              return {
                id: event.id,
                type: event.type,
                names: [
                  ...new Set([
                    event.name,
                    effective.name,
                    ...(alias ? [alias] : []),
                    ...(regional ? [regional] : []),
                  ]),
                ],
                startsAt: effective.startsAt,
                projectedStartsAt: event.startsAt,
              };
            });
          });
        }
        // Store the assessment privately. It is not an approved publication target.
        const assessedRecords = announcementCandidateRows(
          report,
          events,
          regionalProofs,
        );
        if (
          assessedRecords.some(
            (record) =>
              Buffer.byteLength(JSON.stringify(record.snapshot), "utf8") >
              GLOBAL_SOURCE_LIMITS.maxSnapshotBytes,
          )
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "The matching assessment exceeds the storage limit. No records were saved.",
          });
        if (execution.dryRun)
          return {
            inserted: 0,
            examined: records.length,
            coverageLimited: report.coverageLimited || regionalCoverageLimited,
            published: false as const,
            publishedCount: 0,
            publishedBannerCount: 0,
            publicationFailures: 0,
          };
        const result = await tx.globalEventCandidate.createMany({
          data: assessedRecords,
          skipDuplicates: true,
        });
        if (assessedRecords.length)
          await tx.$executeRaw`UPDATE "GlobalEventCandidate" c
            SET "retrievedAt" = x."retrievedAt"
            FROM jsonb_to_recordset(${JSON.stringify(
              assessedRecords.map((record) => ({
                sourceRecordId: record.sourceRecordId,
                contentHash: record.contentHash,
                assessmentHash: record.assessmentHash,
                retrievedAt: record.retrievedAt,
              })),
            )}::jsonb) AS x("sourceRecordId" TEXT, "contentHash" TEXT, "assessmentHash" TEXT, "retrievedAt" TIMESTAMP)
            WHERE c."sourceKind" = 'PUBLISHER_ANNOUNCEMENT'
              AND c."sourceRecordId" = x."sourceRecordId"
              AND c."contentHash" = x."contentHash"
              AND c."assessmentHash" = x."assessmentHash"
              AND c."retrievedAt" < x."retrievedAt"`;
        if (result.count)
          await tx.curatorChange.create({
            data: {
              actorId: authority.actorId,
              targetKind: "GLOBAL_SOURCE",
              targetId: "publisher:NA:announcements",
              action: "COLLECT",
              reason: "Collected publisher announcement candidates for review.",
              before: { published: false },
              after: {
                inserted: result.count,
                examined: records.length,
                articles: report.articles.length,
                coverageLimited: report.coverageLimited || regionalCoverageLimited,
                published: false,
              },
            },
          });
        return {
          inserted: result.count,
          examined: records.length,
          coverageLimited: report.coverageLimited || regionalCoverageLimited,
          events,
          assessedRecords,
        };
      },
      {
        isolationLevel: "Serializable",
        maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
        timeout: IMPORT_EXECUTION_LIMITS.assessmentTransactionTimeoutMs,
      },
    );
  for (let attempt = 1; ; attempt++) {
    try {
      const stored = await progress.stage("publisher_assessments", collect, {
        attempt,
        timeoutMs: IMPORT_EXECUTION_LIMITS.assessmentTransactionTimeoutMs,
      });
      if (!stored.assessedRecords || !stored.events)
        return {
          inserted: stored.inserted,
          examined: stored.examined,
          coverageLimited: stored.coverageLimited,
          published: false,
          publishedCount: 0,
          publishedBannerCount: 0,
          publicationFailures: 0,
        };
      return await publishStoredAnnouncements(
        database,
        authority,
        report,
        {
          ...stored,
          events: stored.events,
          assessedRecords: stored.assessedRecords,
        },
        execution,
        progress,
      );
    } catch (error) {
      if (
        attempt >= GLOBAL_SOURCE_LIMITS.transactionAttempts ||
        !isImportTransactionConflict(error)
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          GLOBAL_SOURCE_LIMITS.transactionRetryDelayMs * attempt,
        ),
      );
      progress.event("publisher_assessments", "retry", { attempt });
    }
  }
}

async function publishStoredAnnouncements(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  report: Report,
  stored: {
    inserted: number;
    examined: number;
    coverageLimited: boolean;
    events: AnnouncementMatchEvent[];
    assessedRecords: Prisma.GlobalEventCandidateCreateManyInput[];
  },
  execution: { allowPublication?: boolean },
  progress: ImportProgress,
) {
  let publishedCount = 0;
  let publishedBannerCount = 0;
  let publicationFailures = 0;
  const proposals =
    execution.allowPublication === false
      ? []
      : report.articles.flatMap((article) => {
          const matches = assessAnnouncementArticle(article, stored.events);
          return article.periods.flatMap((period, index) => {
            const match = matches[index]!;
            return match.targetEventId
              ? [{ article, period, eventId: match.targetEventId }]
              : [];
          });
        });
  const grouped = new Map<string, typeof proposals>();
  for (const proposal of proposals)
    grouped.set(proposal.eventId, [
      ...(grouped.get(proposal.eventId) ?? []),
      proposal,
    ]);
  let index = 0;
  for (const [eventId, group] of [...grouped].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    index++;
    if (
      new Set(group.map(({ period }) => `${period.startsAt}/${period.endsAt}`))
        .size !== 1
    ) {
      publicationFailures++;
      continue;
    }
    const proposal = [...group].sort((a, b) =>
      a.article.sourceUrl.localeCompare(b.article.sourceUrl),
    )[0]!;
    const row = stored.assessedRecords.find(
      (record) =>
        record.sourceRecordId === proposal.period.sourceRecordId &&
        record.sourceUrl === proposal.article.sourceUrl,
    )!;
    for (let attempt = 1; ; attempt++) {
      try {
        const publication = await progress.stage(
          "official_family",
          () =>
            database.$transaction(
              async (tx) => {
                progress.event("official_family", "transaction_acquired", {
                  index,
                  attempt,
                });
                await lockSourceAuthority(tx, authority);
                await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
                const candidate =
                  await tx.globalEventCandidate.findFirstOrThrow({
                    where: {
                      sourceKind: row.sourceKind,
                      sourceRecordId: row.sourceRecordId,
                    },
                    orderBy: [
                      { retrievedAt: "desc" },
                      { createdAt: "desc" },
                      { id: "desc" },
                    ],
                  });
                if (
                  candidate.contentHash !== row.contentHash ||
                  candidate.assessmentHash !== row.assessmentHash
                )
                  throw new Error(
                    "The announcement assessment changed before publication.",
                  );
                return publishAnnouncementFamily(
                  tx,
                  authority.actorId,
                  candidate,
                  eventId,
                );
              },
              {
                isolationLevel: "Serializable",
                maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
                timeout: IMPORT_EXECUTION_LIMITS.familyTransactionTimeoutMs,
              },
            ),
          {
            index,
            total: grouped.size,
            attempt,
            timeoutMs: IMPORT_EXECUTION_LIMITS.familyTransactionTimeoutMs,
          },
        );
        if (publication.changed) publishedCount++;
        if (publication.reason === "CONFLICTING_OFFICIAL_ARTICLES")
          publicationFailures++;
        break;
      } catch (error) {
        const conflict = isImportTransactionConflict(error);
        if (conflict && attempt < GLOBAL_SOURCE_LIMITS.transactionAttempts) {
          progress.event("official_family", "retry", { index, attempt });
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              GLOBAL_SOURCE_LIMITS.transactionRetryDelayMs * attempt,
            ),
          );
          continue;
        }
        publicationFailures++;
        break;
      }
    }
  }
  if (
    execution.allowPublication !== false &&
    report.articles.some((article) =>
      article.periods.some(
        (period) => period.kind === "SUMMON" && period.issues.length === 0,
      ),
    )
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        const banners = await progress.stage(
          "official_banners",
          () =>
            database.$transaction(
              async (tx) => {
                await lockSourceAuthority(tx, authority);
                await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
                return publishOfficialBannerDates(
                  tx,
                  authority.actorId,
                  stored.assessedRecords,
                );
              },
              {
                isolationLevel: "Serializable",
                maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
                timeout: IMPORT_EXECUTION_LIMITS.familyTransactionTimeoutMs,
              },
            ),
          {
            attempt,
            timeoutMs: IMPORT_EXECUTION_LIMITS.familyTransactionTimeoutMs,
          },
        );
        publishedBannerCount = banners.publishedCount;
        publicationFailures += banners.publicationFailures;
        break;
      } catch (error) {
        if (
          isImportTransactionConflict(error) &&
          attempt < GLOBAL_SOURCE_LIMITS.transactionAttempts
        ) {
          progress.event("official_banners", "retry", { attempt });
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              GLOBAL_SOURCE_LIMITS.transactionRetryDelayMs * attempt,
            ),
          );
          continue;
        }
        publicationFailures++;
        break;
      }
    }
  }
  return {
    inserted: stored.inserted,
    examined: stored.examined,
    coverageLimited: stored.coverageLimited,
    published: publishedCount > 0 || publishedBannerCount > 0,
    publishedCount,
    publishedBannerCount,
    publicationFailures,
  };
}
