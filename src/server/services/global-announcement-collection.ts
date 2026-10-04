import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import {
  GLOBAL_ANNOUNCEMENT_LIMITS,
  GLOBAL_SOURCE_LIMITS,
} from "~/shared/global-reconciliation-config";
import { loadPublisherAnnouncements } from "./global-announcement-source";

export const collectAnnouncementsSchema = z.object({}).strict();
type Report = Awaited<ReturnType<typeof loadPublisherAnnouncements>>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function announcementCandidateRows(
  report: Report,
): Prisma.GlobalEventCandidateCreateManyInput[] {
  return report.articles.flatMap((article) => {
    const shared = {
      sourceKind: article.sourceKind,
      sourceUrl: article.sourceUrl,
      retrievedAt: new Date(article.retrievedAt),
      contentHash: article.contentHash,
      name: article.name || article.sourceRecordId,
      targetEventId: null,
    };
    const rows = article.periods.map((period) => {
      const invalidRange = period.issues.includes("INVALID_DATE_RANGE");
      const snapshot = {
        ...period,
        articleName: article.name,
        parserRevision: GLOBAL_ANNOUNCEMENT_LIMITS.parserRevision,
        targetEventId: null,
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
  collectAnnouncementsSchema.parse(rawInput);
  await requireCurator(database, actorId);
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
      const users = await tx.$queryRaw<
        Array<{ isCurator: boolean }>
      >`SELECT "isCurator" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      if (users[0]?.isCurator !== true)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Curator access is required.",
        });
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const result = await tx.globalEventCandidate.createMany({
        data: records,
        skipDuplicates: true,
      });
      if (result.count)
        await tx.curatorChange.create({
          data: {
            actorId,
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
