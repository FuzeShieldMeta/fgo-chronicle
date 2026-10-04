import { TRPCError } from "@trpc/server";
import type { PrismaClient, Prisma } from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import { requireCurator } from "~/server/auth/curator";
import { reviewEventInclude } from "./curator-review";
import { buildGlobalEventPreview } from "./global-event-preview";
import {
  buildGlobalPublicationPlan,
  globalPublicationInputSchema,
} from "./global-publication-plan";

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function publishGlobalEvent(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
) {
  const input = globalPublicationInputSchema.parse(rawInput);
  return database.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      await requireCurator(tx, actorId);
      // Use the collector's lock so a newer assessment cannot appear during approval.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const candidate = await tx.globalEventCandidate.findUnique({
        where: { id: input.preview.candidateId },
      });
      if (!candidate?.targetEventId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This assessment has no verified event target.",
        });
      const eventId = candidate.targetEventId;
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "RewardSource" WHERE "eventId" = ${eventId} ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT r."id" FROM "RewardDefinition" r JOIN "RewardSource" s ON s."id" = r."rewardSourceId" WHERE s."eventId" = ${eventId} ORDER BY r."id" FOR UPDATE OF r`;
      const [event, latest] = await Promise.all([
        tx.event.findUnique({
          relationLoadStrategy: "join",
          where: { id: eventId },
          include: reviewEventInclude,
        }),
        tx.globalEventCandidate.findFirst({
          where: {
            sourceKind: candidate.sourceKind,
            sourceRecordId: candidate.sourceRecordId,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      ]);
      if (!event || !latest)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The source assessment target no longer exists.",
        });
      const preview = buildGlobalEventPreview(
        candidate,
        event,
        input.preview,
        latest.id,
      );
      const plan = buildGlobalPublicationPlan(
        candidate,
        event,
        {
          ...input,
          expectedFingerprint: preview.fingerprint,
        },
        latest.id,
      );
      if (
        event.globalBaseline?.baselineHash === plan.baselineHash &&
        event.globalBaseline.candidateId === candidate.id &&
        !plan.ownershipChanges.length
      )
        return {
          eventId,
          candidateId: candidate.id,
          published: true as const,
          changed: false,
          rewardCount: plan.rewardBaselines.length,
        };
      if (input.expectedFingerprint !== preview.fingerprint)
        throw new TRPCError({
          code: "CONFLICT",
          message: "The event or source changed. Preview the changes again.",
        });
      if (plan.rewardBaselines.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This assessment exceeds the publication reward limit.",
        });

      const baselineData = {
        candidateId: candidate.id,
        baselineHash: plan.baselineHash,
        ...plan.eventBaseline,
        sourceUrl: plan.evidence.sourceUrl,
        retrievedAt: plan.evidence.retrievedAt,
      };
      await tx.eventGlobalBaseline.upsert({
        where: { eventId },
        create: { eventId, ...baselineData },
        update: baselineData,
      });
      if (plan.rewardBaselines.length) {
        const rows = plan.rewardBaselines.map(
          ({ sourceKey: _key, rewardSourceId: _source, ...reward }) => {
            void [_key, _source];
            return {
              ...reward,
              eventId,
              candidateId: candidate.id,
              eventStartsAt: plan.eventBaseline.startsAt,
            };
          },
        );
        // Existing reward identities remain untouched. One statement replaces only their source overlays.
        await tx.$executeRaw`INSERT INTO "RewardGlobalBaseline"
        ("rewardId", "eventId", "candidateId", "itemType", "amount", "expectedAt", "eventStartsAt", "nature", "eligibility", "defaultIncluded", "updatedAt")
        SELECT x."rewardId", x."eventId", x."candidateId", x."itemType"::"RewardItemType", x."amount", x."expectedAt", x."eventStartsAt", x."nature"::"RewardNature", x."eligibility", x."defaultIncluded", CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x("rewardId" TEXT, "eventId" TEXT, "candidateId" TEXT, "itemType" TEXT, "amount" INTEGER, "expectedAt" TIMESTAMP, "eventStartsAt" TIMESTAMP, "nature" TEXT, "eligibility" TEXT, "defaultIncluded" BOOLEAN)
        ON CONFLICT ("rewardId") DO UPDATE SET
          "eventId" = EXCLUDED."eventId", "candidateId" = EXCLUDED."candidateId", "itemType" = EXCLUDED."itemType", "amount" = EXCLUDED."amount", "expectedAt" = EXCLUDED."expectedAt", "eventStartsAt" = EXCLUDED."eventStartsAt", "nature" = EXCLUDED."nature", "eligibility" = EXCLUDED."eligibility", "defaultIncluded" = EXCLUDED."defaultIncluded", "updatedAt" = CURRENT_TIMESTAMP`;
      }
      const eventRelease = plan.ownershipChanges.find(
        (change) => change.targetKind === "EVENT",
      );
      if (eventRelease) {
        const result = await tx.eventCuration.updateMany({
          where: { eventId, revision: eventRelease.expectedRevision },
          data: {
            ownedFields: eventRelease.ownedFields,
            active: eventRelease.active,
            revision: { increment: 1 },
          },
        });
        if (result.count !== 1)
          throw new TRPCError({
            code: "CONFLICT",
            message: "The event correction changed. Preview it again.",
          });
      }
      const rewardReleases = plan.ownershipChanges.filter(
        (change) => change.targetKind === "REWARD",
      );
      if (rewardReleases.length) {
        const updated = await tx.$executeRaw`UPDATE "RewardCuration" AS c
        SET "ownedFields" = x."ownedFields", "active" = x."active", "revision" = c."revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${JSON.stringify(rewardReleases)}::jsonb) AS x("targetId" TEXT, "expectedRevision" INTEGER, "ownedFields" TEXT[], "active" BOOLEAN)
        WHERE c."rewardId" = x."targetId" AND c."revision" = x."expectedRevision"`;
        if (updated !== rewardReleases.length)
          throw new TRPCError({
            code: "CONFLICT",
            message: "A reward correction changed. Preview it again.",
          });
      }
      const evidence = [...event.dateEvidence].sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      )[0];
      const evidenceExists =
        evidence?.sourceKind === plan.evidence.sourceKind &&
        evidence.sourceRecordId === plan.evidence.sourceRecordId &&
        evidence.contentHash === plan.evidence.contentHash &&
        evidence.confirmedStartsAt?.getTime() ===
          plan.evidence.confirmedStartsAt?.getTime() &&
        evidence.confirmedEndsAt?.getTime() ===
          plan.evidence.confirmedEndsAt?.getTime() &&
        evidence.confirmedStartPrecision ===
          plan.evidence.confirmedStartPrecision &&
        evidence.confirmedEndPrecision === plan.evidence.confirmedEndPrecision;
      if (!evidenceExists)
        await tx.eventDateEvidence.create({
          data: { eventId, ...plan.evidence },
        });
      await tx.curatorChange.create({
        data: {
          actorId,
          targetKind: "EVENT",
          targetId: eventId,
          action: "PUBLISH_GLOBAL",
          reason: plan.reason,
          before: json({
            globalBaseline: event.globalBaseline,
            eventCuration: event.curation,
            rewardCurations: event.rewardSources.flatMap((source) =>
              source.rewards.map((reward) => ({
                rewardId: reward.id,
                curation: reward.curation,
                globalBaseline: reward.globalBaseline,
              })),
            ),
          }),
          after: json({
            candidateId: candidate.id,
            baselineHash: plan.baselineHash,
            eventBaseline: plan.eventBaseline,
            rewardBaselines: plan.rewardBaselines,
            ownershipChanges: plan.ownershipChanges,
          }),
        },
      });
      if (rewardReleases.length) {
        const previous = new Map(
          event.rewardSources.flatMap((source) =>
            source.rewards.map(
              (reward) => [reward.id, reward.curation] as const,
            ),
          ),
        );
        await tx.curatorChange.createMany({
          data: rewardReleases.map((release) => ({
            actorId,
            targetKind: "REWARD",
            targetId: release.targetId,
            action: "USE_GLOBAL",
            reason: plan.reason,
            before: json({ curation: previous.get(release.targetId) }),
            after: json({
              candidateId: candidate.id,
              curation: {
                ...previous.get(release.targetId),
                ownedFields: release.ownedFields,
                active: release.active,
                revision: release.expectedRevision + 1,
              },
            }),
          })),
        });
      }
      return {
        eventId,
        candidateId: candidate.id,
        published: true as const,
        changed: true,
        rewardCount: plan.rewardBaselines.length,
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
