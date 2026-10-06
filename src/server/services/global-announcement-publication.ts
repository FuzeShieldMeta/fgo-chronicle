import { createHash } from "node:crypto";
import type { GlobalEventCandidate, Prisma } from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import {
  effectiveEvent,
  effectiveBanner,
  effectiveReward,
  rewardDateShift,
} from "./effective-schedule";
import {
  calculateOfficialFamilyDates,
  type FamilyDateMember,
} from "./official-family-dates";
import { reviewEventInclude } from "./curator-review";
import { dateEvidenceSchema } from "./date-confirmation";
import { ownsField } from "./curation-ownership";
import { publisherArticleUrl } from "./global-announcement-parser";
import { matchAnnouncementEvent } from "./global-announcement-match";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import { z } from "zod";

const assessmentSchema = z.object({
  kind: z.literal("EVENT"),
  issues: z.array(z.string()).length(0),
  sourceRecordId: z.string(),
  context: z.string(),
  rawPeriod: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  startTimezone: z.string().min(1),
  endTimezone: z.string().min(1),
  publicationAllowed: z.literal(false),
  articleName: z.string(),
  matching: z.object({
    targetEventId: z.string(),
    reason: z.literal("UNIQUE_EVENT_MATCH"),
  }),
});

const relativeSources = new Set([
  "LOGIN_BONUS",
  "PRE_CAMPAIGN",
  "EVENT_SHOP",
  "POINT_REWARD",
  "LOTTERY",
  "QUEST_CLEAR",
  "CHALLENGE_QUEST",
  "LIMITED_MISSION",
  "SOCIAL_CAMPAIGN",
]);
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

// The collector calls this under the source lock with a freshly parsed, unique event match.
export async function publishAnnouncementFamily(
  tx: Prisma.TransactionClient,
  actorId: string,
  candidate: GlobalEventCandidate,
  eventId: string,
) {
  if (
    candidate.sourceKind !== "PUBLISHER_ANNOUNCEMENT" ||
    publisherArticleUrl(candidate.sourceUrl) !== candidate.sourceUrl ||
    !candidate.startsAt ||
    !candidate.endsAt
  )
    throw new Error("Invalid announcement source.");
  const target = await tx.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { familyId: true },
  });
  if (target.familyId)
    await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" = ${target.familyId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} OR "familyId" = ${target.familyId} ORDER BY "id" FOR UPDATE`;
  if (target.familyId)
    await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "familyId" = ${target.familyId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT s."id" FROM "RewardSource" s JOIN "Event" e ON e."id" = s."eventId" WHERE e."id" = ${eventId} OR e."familyId" = ${target.familyId} ORDER BY s."id" FOR UPDATE OF s`;
  await tx.$queryRaw`SELECT r."id" FROM "RewardDefinition" r JOIN "RewardSource" s ON s."id" = r."rewardSourceId" JOIN "Event" e ON e."id" = s."eventId" WHERE e."id" = ${eventId} OR e."familyId" = ${target.familyId} ORDER BY r."id" FOR UPDATE OF r`;
  const events = await tx.event.findMany({
    where: target.familyId ? { familyId: target.familyId } : { id: eventId },
    include: reviewEventInclude,
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  const anchor = events.find((event) => event.id === eventId);
  if (!anchor) throw new Error("The announcement target no longer exists.");
  if (anchor.familyId !== target.familyId)
    throw new Error("The announcement family changed.");
  const assessed = assessmentSchema.parse(candidate.snapshot);
  if (
    assessed.matching.targetEventId !== eventId ||
    assessed.sourceRecordId !== candidate.sourceRecordId ||
    new Date(assessed.startsAt).getTime() !== candidate.startsAt.getTime() ||
    new Date(assessed.endsAt).getTime() !== candidate.endsAt.getTime()
  )
    throw new Error("Invalid announcement assessment.");
  const atlasId = /^atlas:JP:event:(\d+):projection:NA$/.exec(
    anchor.sourceKey,
  )?.[1];
  const atlas = atlasId
    ? await tx.globalEventCandidate.findFirst({
        where: { sourceKind: "GLOBAL_GAME_DATA", sourceRecordId: atlasId },
        orderBy: [
          { retrievedAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
      })
    : null;
  const alias = atlas ? verifiedAtlasAlias(atlas, anchor) : null;
  const current = effectiveEvent(anchor);
  if (
    matchAnnouncementEvent(assessed, assessed.articleName, [
      {
        id: eventId,
        type: anchor.type,
        names: [
          ...new Set([anchor.name, current.name, ...(alias ? [alias] : [])]),
        ],
        startsAt: current.startsAt,
        projectedStartsAt: anchor.startsAt,
      },
    ]).targetEventId !== eventId
  )
    throw new Error("The announcement match changed.");
  const existing = anchor.dateOverlay;
  if (existing) {
    const previous = await tx.globalEventCandidate.findUniqueOrThrow({
      where: { id: existing.candidateId },
    });
    if (
      existing.anchorEventId === eventId &&
      previous.sourceUrl !== candidate.sourceUrl &&
      (existing.startsAt.getTime() !== candidate.startsAt.getTime() ||
        existing.endsAt?.getTime() !== candidate.endsAt.getTime())
    )
      return {
        changed: false,
        reason: "CONFLICTING_OFFICIAL_ARTICLES" as const,
      };
    if (
      existing.anchorEventId === eventId &&
      existing.startsAt.getTime() === candidate.startsAt.getTime() &&
      existing.endsAt?.getTime() === candidate.endsAt.getTime() &&
      existing.startStatus === "OFFICIAL" &&
      existing.endStatus === "OFFICIAL" &&
      previous.sourceUrl === candidate.sourceUrl &&
      previous.contentHash === candidate.contentHash
    )
      return { changed: false, reason: "UNCHANGED" as const };
  }
  const banners = target.familyId
    ? await tx.banner.findMany({
        where: { familyId: target.familyId },
        include: { dateOverlay: true },
        orderBy: { id: "asc" },
        take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
      })
    : [];
  const rewards = events.flatMap((event) =>
    event.rewardSources.flatMap((source) =>
      source.rewards.map((reward) => ({ event, source, reward })),
    ),
  );
  if (
    events.length + banners.length + rewards.length >
    GLOBAL_SOURCE_LIMITS.maxBatchRecords
  )
    throw new Error("The family exceeds the publication limit.");
  const members: FamilyDateMember[] = [
    ...events.map((event) => {
      const effective = effectiveEvent(event);
      return {
        id: event.id,
        kind: "EVENT" as const,
        startsAt: effective.startsAt,
        endsAt: effective.endsAt,
        startsAtPrecision: effective.startsAtPrecision,
        endsAtPrecision: effective.endsAtPrecision,
        confirmation: effective.dateConfirmation,
        revision: String(event.curation?.revision ?? 0),
      };
    }),
    ...banners.map((banner) => {
      const effective = effectiveBanner(banner);
      return {
        id: banner.id,
        kind: "BANNER" as const,
        startsAt: effective.startsAt,
        endsAt: effective.endsAt,
        startsAtPrecision: effective.startsAtPrecision,
        endsAtPrecision: effective.endsAtPrecision,
        confirmation: {
          startsAt: banner.dateOverlay?.startStatus ?? banner.status,
          endsAt: banner.endsAt
            ? (banner.dateOverlay?.endStatus ?? banner.status)
            : null,
        },
        revision: banner.updatedAt.toISOString(),
      };
    }),
  ];
  const plan = calculateOfficialFamilyDates({
    anchorEventId: eventId,
    confirmedStartsAt: candidate.startsAt,
    confirmedEndsAt: candidate.endsAt,
    members,
    rewards: rewards.map(({ event, source, reward }) => ({
      id: reward.id,
      eventId: event.id,
      expectedAt: effectiveReward(reward, rewardDateShift(event, reward))
        .expectedAt,
      behaviour:
        relativeSources.has(source.type) && reward.storyWarId === null
          ? ("EVENT_RELATIVE" as const)
          : ("UNKNOWN" as const),
      ownedDate:
        !!reward.curation?.active && ownsField(reward.curation, "expectedAt"),
      revision: String(reward.curation?.revision ?? 0),
    })),
  });
  const evidence = dateEvidenceSchema.parse({
    sourceKind: "PUBLISHER_ANNOUNCEMENT",
    sourceUrl: candidate.sourceUrl,
    sourceRecordId: candidate.sourceRecordId,
    sourceRegion: "NA",
    retrievedAt: candidate.retrievedAt,
    contentHash: candidate.contentHash,
    confirmedStartsAt: candidate.startsAt,
    confirmedEndsAt: candidate.endsAt,
    confirmedStartPrecision: "EXACT",
    confirmedEndPrecision: "EXACT",
  });
  const eventRows: Prisma.EventDateOverlayUncheckedCreateInput[] = [];
  const bannerRows: Prisma.BannerDateOverlayUncheckedCreateInput[] = [];
  for (const member of plan.members) {
    const after = member.after;
    const data = {
      anchorEventId: eventId,
      candidateId: candidate.id,
      startsAt: after.startsAt,
      endsAt: after.endsAt,
      startsAtPrecision: after.startsAtPrecision,
      endsAtPrecision: after.endsAtPrecision,
      startStatus: after.confirmation.startsAt,
      endStatus: after.confirmation.endsAt,
      sourceUrl: candidate.sourceUrl,
      retrievedAt: candidate.retrievedAt,
    };
    if (member.kind === "EVENT") {
      const original = events.find((event) => event.id === member.id)!;
      if (
        member.id !== eventId &&
        member.startOffsetMs === 0 &&
        after.endsAt?.getTime() === member.before.endsAt?.getTime()
      )
        continue;
      const eventData = {
        ...data,
        curationRevision: original.curation?.revision ?? 0,
        curationStartsAt: original.curation?.startsAt ?? null,
        curationEndsAt: original.curation?.endsAt ?? null,
        curationStartPrecision: original.curation?.startsAtPrecision ?? null,
        curationEndPrecision: original.curation?.endsAtPrecision ?? null,
      };
      eventRows.push({ eventId: member.id, ...eventData });
    } else {
      if (
        member.startOffsetMs === 0 &&
        after.endsAt?.getTime() === member.before.endsAt?.getTime()
      )
        continue;
      bannerRows.push({ bannerId: member.id, ...data });
    }
  }
  const rewardRows: Prisma.RewardDateOverlayUncheckedCreateInput[] = [];
  for (const reward of plan.rewards) {
    if (reward.expectedAt?.getTime() === reward.before.expectedAt?.getTime())
      continue;
    const data = {
      anchorEventId: eventId,
      candidateId: candidate.id,
      expectedAt: reward.expectedAt,
    };
    rewardRows.push({ rewardId: reward.id, ...data });
  }
  if (eventRows.length)
    await tx.$executeRaw`INSERT INTO "EventDateOverlay"
    ("eventId", "anchorEventId", "candidateId", "startsAt", "endsAt", "startsAtPrecision", "endsAtPrecision", "startStatus", "endStatus", "curationRevision", "curationStartsAt", "curationEndsAt", "curationStartPrecision", "curationEndPrecision", "sourceUrl", "retrievedAt", "updatedAt")
    SELECT x."eventId", x."anchorEventId", x."candidateId", x."startsAt", x."endsAt", x."startsAtPrecision"::"ScheduleTimePrecision", x."endsAtPrecision"::"ScheduleTimePrecision", x."startStatus"::"ScheduleStatus", x."endStatus"::"ScheduleStatus", x."curationRevision", x."curationStartsAt", x."curationEndsAt", x."curationStartPrecision"::"ScheduleTimePrecision", x."curationEndPrecision"::"ScheduleTimePrecision", x."sourceUrl", x."retrievedAt", CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(eventRows)}::jsonb) AS x("eventId" TEXT, "anchorEventId" TEXT, "candidateId" TEXT, "startsAt" TIMESTAMP, "endsAt" TIMESTAMP, "startsAtPrecision" TEXT, "endsAtPrecision" TEXT, "startStatus" TEXT, "endStatus" TEXT, "curationRevision" INTEGER, "curationStartsAt" TIMESTAMP, "curationEndsAt" TIMESTAMP, "curationStartPrecision" TEXT, "curationEndPrecision" TEXT, "sourceUrl" TEXT, "retrievedAt" TIMESTAMP)
    ON CONFLICT ("eventId") DO UPDATE SET "anchorEventId" = EXCLUDED."anchorEventId", "candidateId" = EXCLUDED."candidateId", "startsAt" = EXCLUDED."startsAt", "endsAt" = EXCLUDED."endsAt", "startsAtPrecision" = EXCLUDED."startsAtPrecision", "endsAtPrecision" = EXCLUDED."endsAtPrecision", "startStatus" = EXCLUDED."startStatus", "endStatus" = EXCLUDED."endStatus", "curationRevision" = EXCLUDED."curationRevision", "curationStartsAt" = EXCLUDED."curationStartsAt", "curationEndsAt" = EXCLUDED."curationEndsAt", "curationStartPrecision" = EXCLUDED."curationStartPrecision", "curationEndPrecision" = EXCLUDED."curationEndPrecision", "sourceUrl" = EXCLUDED."sourceUrl", "retrievedAt" = EXCLUDED."retrievedAt", "updatedAt" = CURRENT_TIMESTAMP`;
  if (bannerRows.length)
    await tx.$executeRaw`INSERT INTO "BannerDateOverlay"
    ("bannerId", "anchorEventId", "candidateId", "startsAt", "endsAt", "startsAtPrecision", "endsAtPrecision", "startStatus", "endStatus", "sourceUrl", "retrievedAt", "updatedAt")
    SELECT x."bannerId", x."anchorEventId", x."candidateId", x."startsAt", x."endsAt", x."startsAtPrecision"::"ScheduleTimePrecision", x."endsAtPrecision"::"ScheduleTimePrecision", x."startStatus"::"ScheduleStatus", x."endStatus"::"ScheduleStatus", x."sourceUrl", x."retrievedAt", CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(bannerRows)}::jsonb) AS x("bannerId" TEXT, "anchorEventId" TEXT, "candidateId" TEXT, "startsAt" TIMESTAMP, "endsAt" TIMESTAMP, "startsAtPrecision" TEXT, "endsAtPrecision" TEXT, "startStatus" TEXT, "endStatus" TEXT, "sourceUrl" TEXT, "retrievedAt" TIMESTAMP)
    ON CONFLICT ("bannerId") DO UPDATE SET "anchorEventId" = EXCLUDED."anchorEventId", "candidateId" = EXCLUDED."candidateId", "startsAt" = EXCLUDED."startsAt", "endsAt" = EXCLUDED."endsAt", "startsAtPrecision" = EXCLUDED."startsAtPrecision", "endsAtPrecision" = EXCLUDED."endsAtPrecision", "startStatus" = EXCLUDED."startStatus", "endStatus" = EXCLUDED."endStatus", "sourceUrl" = EXCLUDED."sourceUrl", "retrievedAt" = EXCLUDED."retrievedAt", "updatedAt" = CURRENT_TIMESTAMP`;
  if (rewardRows.length)
    await tx.$executeRaw`INSERT INTO "RewardDateOverlay"
    ("rewardId", "anchorEventId", "candidateId", "expectedAt", "updatedAt")
    SELECT x."rewardId", x."anchorEventId", x."candidateId", x."expectedAt", CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(rewardRows)}::jsonb) AS x("rewardId" TEXT, "anchorEventId" TEXT, "candidateId" TEXT, "expectedAt" TIMESTAMP)
    ON CONFLICT ("rewardId") DO UPDATE SET "anchorEventId" = EXCLUDED."anchorEventId", "candidateId" = EXCLUDED."candidateId", "expectedAt" = EXCLUDED."expectedAt", "updatedAt" = CURRENT_TIMESTAMP`;
  await tx.eventDateEvidence.create({ data: { eventId, ...evidence } });
  await tx.curatorChange.create({
    data: {
      actorId,
      targetKind: target.familyId ? "FAMILY" : "EVENT",
      targetId: target.familyId ?? eventId,
      action: "PUBLISH_OFFICIAL_DATES",
      reason: "Applied official announcement dates and relative family dates.",
      before: json({
        members: plan.members.map((member) => member.before),
        rewards: plan.rewards.map((reward) => reward.before),
      }),
      after: json({
        candidateId: candidate.id,
        anchorEventId: eventId,
        offsetMs: plan.offsetMs,
        unshiftedUnknownRewardIds: plan.rewards
          .filter(
            (reward) =>
              reward.before.behaviour === "UNKNOWN" && reward.before.expectedAt,
          )
          .map((reward) => reward.id),
        members: plan.members.map(({ id, kind, after }) => ({
          id,
          kind,
          ...after,
        })),
        rewards: plan.rewards.map(({ id, expectedAt }) => ({ id, expectedAt })),
        fingerprint: createHash("sha256")
          .update(JSON.stringify(plan))
          .digest("hex"),
      }),
    },
  });
  return { changed: true, reason: "PUBLISHED" as const };
}
