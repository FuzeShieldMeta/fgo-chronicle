import { createHash } from "node:crypto";
import type { GlobalEventCandidate, Prisma } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_ANNOUNCEMENT_LIMITS,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
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
import { verifiedRegionalCampaignAlias } from "./global-campaign-identity";
import { jpCampaignProofSchema } from "./global-jp-campaign-identity";
import { chapterMissionProofSchema } from "./global-chapter-mission-identity";
import { officialMissionDates } from "./global-mission-date-plan";
import { verifyCampaignMissionEvidence } from "./global-campaign-mission-evidence";
import { z } from "zod";

const assessmentSchema = z.object({
  kind: z.enum(["EVENT", "CAMPAIGN", "QUEST"]),
  issues: z.array(z.string()).length(0),
  sourceRecordId: z.string(),
  context: z.string(),
  rawPeriod: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  startTimezone: z.string().min(1),
  endTimezone: z.string().min(1).nullable(),
  publicationAllowed: z.literal(false),
  articleName: z.string(),
  articleNameAllowed: z.boolean().optional(),
  subjectName: z
    .string()
    .trim()
    .min(1)
    .max(GLOBAL_ANNOUNCEMENT_LIMITS.maxTitleCharacters)
    .optional(),
  regionalIdentity: z.unknown().optional(),
  missionEvidence: z.unknown().optional(),
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
    !candidate.startsAt
  )
    throw new Error("Invalid announcement source.");
  const assessed = assessmentSchema.parse(candidate.snapshot);
  const target = await tx.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { familyId: true },
  });
  // Only a main-event announcement anchors a family move. Campaign and quest
  // sections have their own windows, even when they belong to that family.
  if (assessed.kind !== "EVENT") target.familyId = null;
  if (target.familyId)
    await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" = ${target.familyId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} OR "familyId" = ${target.familyId} ORDER BY "id" FOR UPDATE`;
  if (target.familyId)
    await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "familyId" = ${target.familyId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT s."id" FROM "RewardSource" s JOIN "Event" e ON e."id" = s."eventId" WHERE e."id" = ${eventId} OR e."familyId" = ${target.familyId} ORDER BY s."id" FOR UPDATE OF s`;
  await tx.$queryRaw`SELECT r."id" FROM "RewardDefinition" r JOIN "RewardSource" s ON s."id" = r."rewardSourceId" JOIN "Event" e ON e."id" = s."eventId" WHERE e."id" = ${eventId} OR e."familyId" = ${target.familyId} ORDER BY r."id" FOR UPDATE OF r`;
  const events = await tx.event.findMany({
    relationLoadStrategy: "join",
    where: target.familyId ? { familyId: target.familyId } : { id: eventId },
    include: reviewEventInclude,
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  const anchor = events.find((event) => event.id === eventId);
  if (!anchor) throw new Error("The announcement target no longer exists.");
  if (assessed.kind === "EVENT" && anchor.familyId !== target.familyId)
    throw new Error("The announcement family changed.");
  if (
    assessed.matching.targetEventId !== eventId ||
    assessed.sourceRecordId !== candidate.sourceRecordId ||
    new Date(assessed.startsAt).getTime() !== candidate.startsAt.getTime() ||
    (assessed.endsAt ? new Date(assessed.endsAt).getTime() : null) !==
      (candidate.endsAt?.getTime() ?? null)
  )
    throw new Error("Invalid announcement assessment.");
  const bridge = jpCampaignProofSchema.safeParse(assessed.regionalIdentity);
  const chapter = chapterMissionProofSchema.safeParse(
    assessed.regionalIdentity,
  );
  const atlasId =
    /^atlas:JP:event:(\d+):projection:NA$/.exec(anchor.sourceKey)?.[1] ??
    (bridge.success
      ? bridge.data.atlasId
      : chapter.success
        ? chapter.data.atlasId
        : undefined);
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
  const regional = verifiedRegionalCampaignAlias(
    assessed.regionalIdentity,
    anchor,
    atlas ?? undefined,
  );
  if (
    chapter.success &&
    (!regional ||
      assessed.kind !== "CAMPAIGN" ||
      chapter.data.globalArticle.url !== candidate.sourceUrl ||
      chapter.data.globalArticle.contentHash !== candidate.contentHash ||
      chapter.data.globalArticle.name !== assessed.articleName ||
      chapter.data.globalArticle.startsAt !== assessed.startsAt ||
      chapter.data.globalArticle.endsAt !== assessed.endsAt)
  )
    throw new Error("The chapter mission evidence changed.");
  const current = effectiveEvent(anchor);
  const campaignMissions =
    assessed.missionEvidence === undefined ||
    assessed.kind !== "CAMPAIGN" ||
    !assessed.endsAt
      ? null
      : verifyCampaignMissionEvidence(
          assessed.missionEvidence,
          anchor,
          {
            url: candidate.sourceUrl,
            contentHash: candidate.contentHash,
            sourceRecordId: candidate.sourceRecordId,
            name: assessed.articleName,
            startsAt: assessed.startsAt,
            endsAt: assessed.endsAt,
          },
          regional ? [regional] : [],
        );
  if (assessed.missionEvidence !== undefined && !campaignMissions)
    throw new Error("The campaign mission evidence changed.");
  if (
    matchAnnouncementEvent(assessed, assessed.articleName, [
      {
        id: eventId,
        type: anchor.type,
        names: [
          ...new Set([
            anchor.name,
            current.name,
            ...(alias ? [alias] : []),
            ...(regional ? [regional] : []),
          ]),
        ],
        startsAt: current.startsAt,
        projectedStartsAt: anchor.startsAt,
        ...(alias && atlas?.targetEventId === eventId
          ? { verifiedAtlasName: alias }
          : {}),
      },
    ]).targetEventId !== eventId
  )
    throw new Error("The announcement match changed.");
  const existing = anchor.dateOverlay;
  let anchorUnchanged = false;
  if (existing) {
    const previous = await tx.globalEventCandidate.findUniqueOrThrow({
      where: { id: existing.candidateId },
    });
    if (
      existing.anchorEventId === eventId &&
      previous.sourceUrl !== candidate.sourceUrl &&
      (existing.startsAt.getTime() !== candidate.startsAt.getTime() ||
        (candidate.endsAt &&
          existing.endsAt?.getTime() !== candidate.endsAt.getTime()))
    )
      return {
        changed: false,
        reason: "CONFLICTING_OFFICIAL_ARTICLES" as const,
      };
    if (
      existing.anchorEventId === eventId &&
      existing.startsAt.getTime() === candidate.startsAt.getTime() &&
      (!candidate.endsAt ||
        existing.endsAt?.getTime() === candidate.endsAt.getTime()) &&
      existing.startStatus === "OFFICIAL" &&
      (!candidate.endsAt || existing.endStatus === "OFFICIAL") &&
      previous.sourceUrl === candidate.sourceUrl &&
      previous.contentHash === candidate.contentHash
    )
      anchorUnchanged = true;
  }
  const banners = target.familyId
    ? await tx.banner.findMany({
        relationLoadStrategy: "join",
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
  const scheduleUnchanged =
    anchorUnchanged &&
    banners.every(
      (banner) => !!banner.dateOverlay || banner.status === "OFFICIAL",
    ) &&
    events.every(
      (event) =>
        event.id === eventId ||
        !!event.dateOverlay ||
        event.status === "OFFICIAL",
    );
  // A newly linked imported member has not followed earlier curator/official moves.
  // Rebase it from the imported anchor, not from the already corrected anchor.
  const importedRelative = (
    date: Date | null,
    precision: "EXACT" | "DATE_ONLY" | null,
  ) => {
    if (!date) return null;
    const offset =
      precision === "DATE_ONLY"
        ? (Math.floor(date.getTime() / MILLISECONDS_PER_DAY) -
            Math.floor(anchor.startsAt.getTime() / MILLISECONDS_PER_DAY)) *
          MILLISECONDS_PER_DAY
        : date.getTime() - anchor.startsAt.getTime();
    return new Date(current.startsAt.getTime() + offset);
  };
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
        startsAt:
          event.id !== eventId &&
          !event.dateOverlay &&
          !(event.curation?.active && ownsField(event.curation, "startsAt")) &&
          effective.dateConfirmation.startsAt !== "OFFICIAL"
            ? importedRelative(event.startsAt, event.startsAtPrecision)!
            : effective.startsAt,
        endsAt:
          event.id !== eventId &&
          !event.dateOverlay &&
          !(event.curation?.active && ownsField(event.curation, "endsAt")) &&
          effective.dateConfirmation.endsAt !== "OFFICIAL"
            ? importedRelative(event.endsAt, event.endsAtPrecision)
            : effective.endsAt,
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
        startsAt:
          !banner.dateOverlay && banner.status === "PROJECTED"
            ? importedRelative(banner.startsAt, banner.startsAtPrecision)!
            : effective.startsAt,
        endsAt:
          !banner.dateOverlay && banner.status === "PROJECTED"
            ? importedRelative(banner.endsAt, banner.endsAtPrecision)
            : effective.endsAt,
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
    rewards: rewards.map(({ event, source, reward }) => {
      const independentDate =
        !!reward.globalBaseline ||
        reward.storyWarId !== null ||
        reward.dateBasis === "ABSOLUTE";
      return {
        id: reward.id,
        eventId: event.id,
        expectedAt: effectiveReward(
          independentDate ? { ...reward, dateOverlay: null } : reward,
          independentDate
            ? 0
            : rewardDateShift(event, reward) +
                (!reward.dateOverlay &&
                reward.dateBasis !== "EVENT_END" &&
                relativeSources.has(source.type) &&
                reward.storyWarId === null &&
                !(
                  reward.curation?.active &&
                  ownsField(reward.curation, "expectedAt")
                )
                  ? members
                      .find(
                        (member) =>
                          member.kind === "EVENT" && member.id === event.id,
                      )!
                      .startsAt.getTime() -
                    effectiveEvent(event).startsAt.getTime()
                  : 0),
        ).expectedAt,
        dateBasis: independentDate ? "ABSOLUTE" : reward.dateBasis,
        behaviour:
          relativeSources.has(source.type) && reward.storyWarId === null
            ? ("EVENT_RELATIVE" as const)
            : ("UNKNOWN" as const),
        ownedDate:
          !!reward.curation?.active && ownsField(reward.curation, "expectedAt"),
        revision: String(reward.curation?.revision ?? 0),
      };
    }),
  });
  const missionEvidence =
    campaignMissions ?? (chapter.success ? chapter.data : null);
  if (missionEvidence) {
    const dates = officialMissionDates(
      missionEvidence,
      rewards
        .filter(({ event }) => event.id === eventId)
        .map(({ source, reward }) => ({
          id: reward.id,
          sourceKey: reward.sourceKey,
          itemType: reward.itemType,
          amount: reward.amount,
          eligibility: reward.eligibility,
          sourceType: source.type,
          protectedDate:
            !!reward.globalBaseline ||
            reward.storyWarId !== null ||
            reward.dateBasis === "ABSOLUTE" ||
            (!!reward.curation?.active &&
              ownsField(reward.curation, "expectedAt")),
        })),
    );
    for (const reward of plan.rewards) {
      const deadline = dates.get(reward.id);
      if (deadline) reward.expectedAt = deadline;
    }
  }
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
    confirmedEndPrecision: candidate.endsAt ? "EXACT" : null,
  });
  const eventRows: Prisma.EventDateOverlayUncheckedCreateInput[] = [];
  const bannerRows: Prisma.BannerDateOverlayUncheckedCreateInput[] = [];
  for (const member of plan.members) {
    if (scheduleUnchanged) continue;
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
        original.dateOverlay?.startStatus === "OFFICIAL" &&
        original.dateOverlay.endStatus === "OFFICIAL"
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
      const original = banners.find((banner) => banner.id === member.id)!;
      if (
        original.status === "OFFICIAL" ||
        (original.dateOverlay?.startStatus === "OFFICIAL" &&
          original.dateOverlay.endStatus === "OFFICIAL")
      )
        continue;
      bannerRows.push({ bannerId: member.id, ...data });
    }
  }
  const rewardRows: Prisma.RewardDateOverlayUncheckedCreateInput[] = [];
  for (const reward of plan.rewards) {
    const original = rewards.find((record) => record.reward.id === reward.id)!;
    const before = effectiveReward(
      original.reward,
      rewardDateShift(original.event, original.reward),
    ).expectedAt;
    if (reward.expectedAt?.getTime() === before?.getTime()) continue;
    const data = {
      anchorEventId: eventId,
      candidateId: candidate.id,
      expectedAt: reward.expectedAt,
    };
    rewardRows.push({ rewardId: reward.id, ...data });
  }
  if (scheduleUnchanged && !rewardRows.length)
    return { changed: false, reason: "UNCHANGED" as const };
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
  if (!anchorUnchanged)
    await tx.eventDateEvidence.create({ data: { eventId, ...evidence } });
  await tx.curatorChange.create({
    data: {
      actorId,
      targetKind: target.familyId ? "FAMILY" : "EVENT",
      targetId: target.familyId ?? eventId,
      action: "PUBLISH_OFFICIAL_DATES",
      reason: "Applied official announcement dates and relative family dates.",
      before: json({
        members: plan.members.map((member) => {
          const original =
            member.kind === "EVENT"
              ? effectiveEvent(events.find((event) => event.id === member.id)!)
              : effectiveBanner(
                  banners.find((banner) => banner.id === member.id)!,
                );
          return {
            ...member.before,
            startsAt: original.startsAt,
            endsAt: original.endsAt,
          };
        }),
        rewards: plan.rewards.map((reward) => {
          const original = rewards.find(
            (record) => record.reward.id === reward.id,
          )!;
          return {
            ...reward.before,
            expectedAt: effectiveReward(
              original.reward,
              rewardDateShift(original.event, original.reward),
            ).expectedAt,
          };
        }),
      }),
      after: json({
        candidateId: candidate.id,
        anchorEventId: eventId,
        offsetMs: plan.offsetMs,
        updatedRewardDates: rewardRows.length,
        unresolvedRewardDates: plan.unresolvedRewardDates,
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
