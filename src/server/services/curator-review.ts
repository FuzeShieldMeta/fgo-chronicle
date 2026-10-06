import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  effectiveEvent,
  effectiveReward,
  eventIsHidden,
  rewardDateShift,
} from "./effective-schedule";

const latestReview = {
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: 1,
};

export const reviewEventInclude = {
  curation: true,
  globalBaseline: true,
  dateOverlay: true,
  dateEvidence: true,
  reviews: latestReview,
  rewardSources: {
    include: {
      rewards: {
        include: {
          curation: true,
          globalBaseline: true,
          dateOverlay: true,
          reviews: latestReview,
        },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "asc" },
  },
} satisfies Prisma.EventInclude;

export type ReviewEvent = Prisma.EventGetPayload<{
  include: typeof reviewEventInclude;
}>;
type ReviewReward = ReviewEvent["rewardSources"][number]["rewards"][number];

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function eventReviewSnapshot(event: ReviewEvent) {
  const fields = (
    value: typeof event | ReturnType<typeof effectiveEvent<typeof event>>,
  ) => ({
    name: value.name,
    type: value.type,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    startsAtPrecision: value.startsAtPrecision,
    endsAtPrecision: value.endsAtPrecision,
    status: value.status,
    sourceUrl: value.sourceUrl,
    sourceRegion: value.sourceRegion,
    sourceStartsAt: value.sourceStartsAt,
    sourceEndsAt: value.sourceEndsAt,
    familyId: value.familyId,
  });
  return {
    targetKind: "EVENT" as const,
    targetId: event.id,
    sourceHash: fingerprint({
      ...fields(event),
      hidden: false,
      ...(event.globalBaseline
        ? { global: fields(effectiveEvent({ ...event, curation: null })) }
        : {}),
    }),
    effectiveHash: fingerprint({
      ...fields(effectiveEvent(event)),
      hidden: eventIsHidden(event),
    }),
  };
}

export function rewardReviewSnapshot(event: ReviewEvent, reward: ReviewReward) {
  const source = event.rewardSources.find(
    (value) => value.id === reward.rewardSourceId,
  );
  return rewardReviewSnapshotForSource(reward, source, event);
}

type SnapshotReward = Pick<
  ReviewReward,
  | "id"
  | "rewardSourceId"
  | "itemType"
  | "amount"
  | "expectedAt"
  | "nature"
  | "eligibility"
  | "storyWarId"
  | "storyReleaseAt"
  | "defaultIncluded"
  | "reviewedAt"
> & {
  curation?: ReviewReward["curation"];
  dateOverlay?: Parameters<typeof effectiveReward>[0]["dateOverlay"];
  globalBaseline?: Parameters<typeof effectiveReward>[0]["globalBaseline"];
};

export function rewardReviewSnapshotForSource(
  reward: SnapshotReward,
  source: { type: string; evidenceUrl: string } | undefined,
  event: Parameters<typeof rewardDateShift>[0],
) {
  const fields = (
    value: SnapshotReward | ReturnType<typeof effectiveReward<SnapshotReward>>,
  ) => ({
    itemType: value.itemType,
    amount: value.amount,
    expectedAt: value.expectedAt,
    nature: value.nature,
    eligibility: value.eligibility,
    storyWarId: value.storyWarId,
    storyReleaseAt: value.storyReleaseAt,
    defaultIncluded: value.defaultIncluded,
    sourceId: value.rewardSourceId,
    evidenceUrl: source?.evidenceUrl ?? null,
    sourceType: source?.type ?? null,
  });
  return {
    targetKind: "REWARD" as const,
    targetId: reward.id,
    sourceHash: fingerprint({
      ...fields(reward),
      ...(reward.globalBaseline
        ? { global: fields(effectiveReward({ ...reward, curation: null })) }
        : {}),
    }),
    effectiveHash: fingerprint({
      ...fields(effectiveReward(reward, rewardDateShift(event, reward))),
      hidden: event ? eventIsHidden(event) : false,
    }),
  };
}

const snapshotSchema = z
  .object({
    targetKind: z.enum(["EVENT", "REWARD"]),
    targetId: z.string().min(1).max(100),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectiveHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const reviewInputSchema = z
  .object({
    eventId: z.string().min(1).max(100),
    scope: z.enum(["EVENT", "REWARD", "ALL"]),
    snapshots: z.array(snapshotSchema).min(1).max(5000),
  })
  .strict();

export function reviewState(
  snapshot: z.infer<typeof snapshotSchema>,
  reviews: Array<{
    sourceHash: string;
    effectiveHash: string;
    createdAt: Date;
  }>,
) {
  const latest = reviews[0];
  const sourceChanged = Boolean(
    latest && latest.sourceHash !== snapshot.sourceHash,
  );
  const current = Boolean(
    latest && !sourceChanged && latest.effectiveHash === snapshot.effectiveHash,
  );
  return {
    status: !latest
      ? ("UNREVIEWED" as const)
      : current
        ? ("REVIEWED" as const)
        : ("NEEDS_REVIEW" as const),
    sourceChanged,
    reviewedAt: latest?.createdAt ?? null,
    snapshot,
  };
}

export function describeEventReview(event: ReviewEvent) {
  return {
    ...event,
    review: reviewState(eventReviewSnapshot(event), event.reviews),
    rewardSources: event.rewardSources.map((source) => ({
      ...source,
      rewards: source.rewards.map((reward) => ({
        ...reward,
        review: reviewState(
          rewardReviewSnapshot(event, reward),
          reward.reviews,
        ),
      })),
    })),
  };
}

export async function saveReview(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
) {
  const input = reviewInputSchema.parse(rawInput);
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
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${input.eventId} FOR UPDATE`;
      // Lock sources before rewards. Imports cannot change this event's membership during review.
      await tx.$queryRaw`SELECT "id" FROM "RewardSource" WHERE "eventId" = ${input.eventId} ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT r."id" FROM "RewardDefinition" r JOIN "RewardSource" s ON s."id" = r."rewardSourceId" WHERE s."eventId" = ${input.eventId} ORDER BY r."id" FOR UPDATE OF r`;
      const event = await tx.event.findUnique({
        relationLoadStrategy: "join",
        where: { id: input.eventId },
        include: reviewEventInclude,
      });
      if (!event)
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      const all = [
        eventReviewSnapshot(event),
        ...event.rewardSources.flatMap((source) =>
          source.rewards.map((reward) => rewardReviewSnapshot(event, reward)),
        ),
      ];
      const expected =
        input.scope === "ALL"
          ? all
          : input.scope === "EVENT"
            ? all.slice(0, 1)
            : all.filter(
                (value) =>
                  value.targetKind === "REWARD" &&
                  value.targetId === input.snapshots[0]?.targetId,
              );
      const submitted = new Map(
        input.snapshots.map((value) => [value.targetId, value]),
      );
      if (
        !expected.length ||
        submitted.size !== input.snapshots.length ||
        expected.length !== submitted.size ||
        expected.some((value) => {
          const candidate = submitted.get(value.targetId);
          return (
            candidate?.targetKind !== value.targetKind ||
            candidate?.sourceHash !== value.sourceHash ||
            candidate?.effectiveHash !== value.effectiveHash
          );
        })
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The content changed. Reload it before reviewing.",
        });
      }
      // Use the same review time for the event and its rewards.
      const createdAt = new Date();
      const eventReviews: Prisma.EventReviewCreateManyInput[] = [];
      const rewardReviews: Prisma.RewardReviewCreateManyInput[] = [];
      const changes: Prisma.CuratorChangeCreateManyInput[] = [];
      for (const value of expected) {
        const data = {
          actorId,
          sourceHash: value.sourceHash,
          effectiveHash: value.effectiveHash,
          createdAt,
        };
        if (value.targetKind === "EVENT")
          eventReviews.push({ ...data, eventId: value.targetId });
        else rewardReviews.push({ ...data, rewardId: value.targetId });
        changes.push({
          actorId,
          targetKind: value.targetKind,
          targetId: value.targetId,
          action: "REVIEW",
          reason:
            input.scope === "ALL"
              ? "Reviewed event and current rewards"
              : "Reviewed current content",
          before: {
            sourceHash: value.sourceHash,
            effectiveHash: value.effectiveHash,
          },
          after: {
            ...value,
            reviewedAt: createdAt.toISOString(),
            eventId: event.id,
            scope: input.scope,
          },
        });
      }
      if (eventReviews.length)
        await tx.eventReview.createMany({ data: eventReviews });
      if (rewardReviews.length)
        await tx.rewardReview.createMany({ data: rewardReviews });
      await tx.curatorChange.createMany({ data: changes });
      return {
        eventId: event.id,
        reviewedCount: expected.length,
        reviews: expected.map((snapshot) =>
          reviewState(snapshot, [{ ...snapshot, createdAt }]),
        ),
      };
    },
    { maxWait: 5000, timeout: 15000 },
  );
}
