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
} from "~/shared/global-reconciliation-config";
import { loadPublisherAnnouncements } from "./global-announcement-source";
import {
  assessAnnouncementArticle,
  type AnnouncementMatchEvent,
} from "./global-announcement-match";
import { effectiveEvent } from "./effective-schedule";
import {
  publicEventGlobalBaselineSelect,
  publicDateEvidenceSelect,
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
      const snapshot = {
        ...period,
        articleName: article.name,
        parserRevision: GLOBAL_ANNOUNCEMENT_LIMITS.parserRevision,
        targetEventId: null,
        ...(matches ? { matching: matches[index] } : {}),
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
  execution: { dryRun?: boolean } = {},
) {
  collectAnnouncementsSchema.parse(rawInput);
  await requireSourceAuthority(database, authority);
  const report = await loadPublisherAnnouncements(dependencies);
  const records = announcementCandidateRows(report);
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
  return database.$transaction(
    async (tx) => {
      await lockSourceAuthority(tx, authority);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const starts = report.articles.flatMap((article) =>
        article.periods.flatMap((period) => {
          const start = period.startsAt
            ? new Date(period.startsAt).getTime()
            : NaN;
          return period.kind === "EVENT" && Number.isFinite(start)
            ? [start]
            : [];
        }),
      );
      let events: AnnouncementMatchEvent[] = [];
      if (starts.length) {
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
            type: "MAIN_EVENT",
            OR: [
              { startsAt: range },
              { globalBaseline: { is: { startsAt: range } } },
              { curation: { is: { active: true, startsAt: range } } },
            ],
          },
          select: {
            id: true,
            name: true,
            type: true,
            startsAt: true,
            endsAt: true,
            startsAtPrecision: true,
            endsAtPrecision: true,
            status: true,
            updatedAt: true,
            curation: true,
            globalBaseline: publicEventGlobalBaselineSelect,
            dateEvidence: publicDateEvidenceSelect,
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
        events = candidates.map((event) => {
          const effective = effectiveEvent(event);
          return {
            id: event.id,
            type: event.type,
            names: [...new Set([event.name, effective.name])],
            startsAt: effective.startsAt,
            projectedStartsAt: event.startsAt,
          };
        });
      }
      // Store the assessment privately. It is not an approved publication target.
      const assessedRecords = announcementCandidateRows(report, events);
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
          coverageLimited: report.coverageLimited,
          published: false as const,
        };
      const result = await tx.globalEventCandidate.createMany({
        data: assessedRecords,
        skipDuplicates: true,
      });
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
              coverageLimited: report.coverageLimited,
              published: false,
            },
          },
        });
      return {
        inserted: result.count,
        examined: records.length,
        coverageLimited: report.coverageLimited,
        published: false as const,
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
