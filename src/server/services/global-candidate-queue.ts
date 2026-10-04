import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { Prisma, type PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import { reportGlobalEvents } from "../../../scripts/lib/global-event-candidates.mjs";
import {
  GLOBAL_SOURCE_LIMITS,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";

export const collectGlobalCandidatesSchema = z
  .object({
    from: z.date(),
    through: z.date(),
  })
  .strict()
  .refine(
    ({ from, through }) =>
      through >= from &&
      through.getTime() - from.getTime() <
        GLOBAL_SOURCE_LIMITS.maxRangeDays * MILLISECONDS_PER_DAY,
    {
      message: `Choose a valid date range of no more than ${GLOBAL_SOURCE_LIMITS.maxRangeDays} days.`,
    },
  );
export const globalCandidateQueueSchema = z
  .object({
    page: z.number().int().min(0).max(GLOBAL_SOURCE_LIMITS.maxPage).default(0),
    view: z.enum(["ALL", "MATCHED", "UNRESOLVED"]).default("ALL"),
    sort: z.enum(["NEWEST", "EARLIEST"]).default("NEWEST"),
  })
  .strict();
type Report = Awaited<ReturnType<typeof reportGlobalEvents>>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function globalCandidateRows(
  report: Report,
): Prisma.GlobalEventCandidateCreateManyInput[] {
  const candidates = report.candidates.map((candidate) => ({
    sourceKind: candidate.evidence.sourceKind,
    sourceRecordId: candidate.evidence.sourceRecordId,
    sourceUrl: candidate.evidence.url,
    retrievedAt: new Date(candidate.evidence.retrievedAt),
    contentHash: candidate.evidence.contentHash,
    assessmentHash: hash({
      targetEventId: z.string().nullable().parse(candidate.targetEventId),
      reasons: candidate.reasons,
      jpRecord: candidate.jpEvidence?.record ?? null,
      coverageIssues: candidate.coverageIssues,
      embeddedRewardTotals: candidate.embeddedRewardTotals,
    }),
    name: candidate.globalName,
    startsAt: new Date(candidate.startsAt),
    endsAt: new Date(candidate.endsAt),
    targetEventId: z.string().nullable().parse(candidate.targetEventId),
    reasons: candidate.reasons,
    snapshot: json(candidate),
  }));
  const na = report.sources.find((source) => source.region === "NA");
  if (!na) throw new Error("The Global report has no NA source.");
  const issues = na.sourceIssues.map((issue) => ({
    sourceKind: "GLOBAL_GAME_DATA",
    sourceRecordId: String(issue.sourceRecordId),
    sourceUrl: `https://api.atlasacademy.io/nice/NA/event/${issue.sourceRecordId}`,
    retrievedAt: new Date(na.retrievedAt),
    contentHash: `sha256:${hash(issue)}`,
    assessmentHash: hash({ reasons: [issue.code] }),
    name: String(issue.name),
    startsAt: null,
    endsAt: null,
    targetEventId: null,
    reasons: [issue.code],
    snapshot: json({ ...issue, publicationAllowed: false }),
  }));
  return [...candidates, ...issues];
}

export async function collectGlobalCandidates(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
  dependencies: Parameters<typeof reportGlobalEvents>[2] = {},
) {
  const input = collectGlobalCandidatesSchema.parse(rawInput);
  await requireCurator(database, actorId);
  const report = await reportGlobalEvents(database, input, dependencies);
  const records = globalCandidateRows(report);
  if (
    records.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords ||
    records.some(
      (record) =>
        Buffer.byteLength(JSON.stringify(record.snapshot), "utf8") >
        GLOBAL_SOURCE_LIMITS.maxSnapshotBytes,
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The source assessment exceeds the collection limit. Choose a shorter range.",
    });
  }
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
      // Serialise collectors so repeated or overlapping refreshes retain one assessment.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const targetIds = [
        ...new Set(
          records.flatMap((record) =>
            record.targetEventId ? [record.targetEventId] : [],
          ),
        ),
      ].sort();
      const currentTargets = targetIds.length
        ? await tx.$queryRaw<
            Array<{ id: string; sourceKey: string; sourceRegion: string }>
          >`
        SELECT "id", "sourceKey", "sourceRegion" FROM "Event"
        WHERE "id" IN (${Prisma.join(targetIds)}) ORDER BY "id" FOR SHARE
      `
        : [];
      const targets = new Map(
        currentTargets.map((target) => [target.id, target]),
      );
      // A source identity can change while exports are fetched. Never retain a stale match.
      for (const record of records) {
        if (!record.targetEventId) continue;
        const target = targets.get(record.targetEventId);
        const expectedKey = `atlas:JP:event:${record.sourceRecordId}:projection:NA`;
        if (target?.sourceKey !== expectedKey || target.sourceRegion !== "JP") {
          record.targetEventId = null;
          record.reasons = ["EXISTING_IDENTITY_CHANGED"];
          record.assessmentHash = hash({
            contentHash: record.contentHash,
            reasons: record.reasons,
          });
          record.snapshot = json({
            ...(record.snapshot as Record<string, unknown>),
            targetEventId: null,
            reasons: record.reasons,
          });
        }
      }
      const result = await tx.globalEventCandidate.createMany({
        data: records,
        skipDuplicates: true,
      });
      if (result.count)
        await tx.curatorChange.create({
          data: {
            actorId,
            targetKind: "GLOBAL_SOURCE",
            targetId: "atlas:NA:events",
            action: "COLLECT",
            reason: "Collected Atlas Global source candidates.",
            before: { published: false },
            after: {
              from: input.from.toISOString(),
              through: input.through.toISOString(),
              inserted: result.count,
              sources: json(report.sources),
            },
          },
        });
      return {
        inserted: result.count,
        examined: records.length,
        published: false as const,
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}

export async function getGlobalCandidateQueue(
  database: PrismaClient,
  rawInput: unknown,
) {
  const input = globalCandidateQueueSchema.parse(rawInput);
  const where: Prisma.GlobalEventCandidateWhereInput =
    input.view === "MATCHED"
      ? { targetEventId: { not: null } }
      : input.view === "UNRESOLVED"
        ? { targetEventId: null }
        : {};
  const [entries, total] = await Promise.all([
    database.globalEventCandidate.findMany({
      where,
      orderBy:
        input.sort === "EARLIEST"
          ? [
              { startsAt: { sort: "asc", nulls: "last" } },
              { createdAt: "desc" },
              { id: "desc" },
            ]
          : [{ createdAt: "desc" }, { id: "desc" }],
      skip: input.page * GLOBAL_SOURCE_LIMITS.pageSize,
      take: GLOBAL_SOURCE_LIMITS.pageSize,
    }),
    database.globalEventCandidate.count({ where }),
  ]);
  return {
    entries,
    total,
    page: input.page,
    hasNext: (input.page + 1) * GLOBAL_SOURCE_LIMITS.pageSize < total,
  };
}
