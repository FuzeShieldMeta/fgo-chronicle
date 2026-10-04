import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  RewardItemType,
  RewardNature,
  RewardSourceType,
  type PrismaClient,
  type GlobalEventCandidate,
} from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import {
  eventCurationFields,
  rewardCurationFields,
  ownsField,
} from "./curation-ownership";
import {
  effectiveEvent,
  effectiveReward,
  eventIsHidden,
  rewardDateShift,
} from "./effective-schedule";
import { reviewEventInclude, type ReviewEvent } from "./curator-review";
import {
  dateEvidenceSchema,
  describeDateConfirmation,
} from "./date-confirmation";

const eventFields = ["name", "startsAt", "endsAt"] as const;
export const globalEventPreviewSchema = z
  .object({
    candidateId: z.string().min(1).max(100),
    useGlobalEventFields: z
      .array(z.enum(eventFields))
      .max(eventFields.length)
      .default([]),
    useGlobalRewardFields: z
      .array(
        z
          .object({
            rewardId: z.string().min(1).max(100),
            fields: z
              .array(z.enum(rewardCurationFields))
              .max(rewardCurationFields.length),
          })
          .strict(),
      )
      .max(GLOBAL_SOURCE_LIMITS.maxBatchRecords)
      .default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.useGlobalEventFields).size !==
        input.useGlobalEventFields.length ||
      new Set(input.useGlobalRewardFields.map((value) => value.rewardId))
        .size !== input.useGlobalRewardFields.length ||
      input.useGlobalRewardFields.some(
        (value) => new Set(value.fields).size !== value.fields.length,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Select each field and reward only once.",
      });
    }
  });
const sourceRewards = z.array(
  z.object({
    sourceKey: z.string().min(1),
    type: z.nativeEnum(RewardSourceType),
    rewards: z.array(
      z.object({
        sourceKey: z.string().min(1),
        itemType: z.nativeEnum(RewardItemType),
        amount: z.number().int().min(1),
        expectedAt: z.string().datetime().nullable(),
        nature: z.nativeEnum(RewardNature),
        eligibility: z.string().nullable(),
        defaultIncluded: z.boolean(),
      }),
    ),
  }),
);
const snapshotSchema = z.object({
  identity: z.literal("ASSOCIATED"),
  projectedSourceKey: z.string(),
  sourceRecordId: z.number().int().positive(),
  globalName: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  startsAtPrecision: z.literal("EXACT"),
  endsAtPrecision: z.literal("EXACT"),
  warIds: z.array(z.number().int().positive()).min(1),
  jpEvidence: z
    .object({
      record: z
        .object({
          id: z.number().int().positive(),
          warIds: z.array(z.number().int().positive()).min(1),
        })
        .passthrough(),
    })
    .passthrough(),
  embeddedRewardSources: sourceRewards,
  jpEmbeddedRewardSources: sourceRewards,
});
type SourceReward = z.infer<typeof sourceRewards>[number]["rewards"][number];
type Choice = z.infer<typeof globalEventPreviewSchema>;
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function indexSourceRewards(sources: z.infer<typeof sourceRewards>) {
  const entries = new Map<
    string,
    Array<{ sourceType: RewardSourceType; value: SourceReward }>
  >();
  for (const source of sources)
    for (const value of source.rewards) {
      const entriesForKey = entries.get(value.sourceKey) ?? [];
      entriesForKey.push({ sourceType: source.type, value });
      entries.set(value.sourceKey, entriesForKey);
    }
  return entries;
}

export function buildGlobalEventPreview(
  candidate: GlobalEventCandidate,
  event: ReviewEvent,
  input: Choice,
  latestCandidateId: string,
) {
  const snapshot = snapshotSchema.safeParse(candidate.snapshot);
  if (!snapshot.success)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This assessment lacks verified reward-source data. Collect the source again.",
    });
  const source = snapshot.data;
  const problems: string[] = [];
  if (candidate.id !== latestCandidateId)
    problems.push("SOURCE_ASSESSMENT_SUPERSEDED");
  if (
    candidate.targetEventId !== event.id ||
    candidate.reasons.length ||
    event.sourceRegion !== "JP" ||
    event.sourceKey !== source.projectedSourceKey ||
    source.projectedSourceKey !==
      `atlas:JP:event:${candidate.sourceRecordId}:projection:NA` ||
    source.sourceRecordId !== Number(candidate.sourceRecordId) ||
    source.jpEvidence.record.id !== source.sourceRecordId ||
    fingerprint([...source.warIds].sort((a, b) => a - b)) !==
      fingerprint([...source.jpEvidence.record.warIds].sort((a, b) => a - b)) ||
    new Set(source.warIds).size !== source.warIds.length ||
    new Set(source.jpEvidence.record.warIds).size !==
      source.jpEvidence.record.warIds.length
  )
    problems.push("EXISTING_IDENTITY_CHANGED");
  if (
    candidate.sourceKind !== "GLOBAL_GAME_DATA" ||
    candidate.sourceUrl !==
      `https://api.atlasacademy.io/nice/NA/event/${candidate.sourceRecordId}` ||
    candidate.name !== source.globalName ||
    candidate.startsAt?.toISOString() !== source.startsAt ||
    candidate.endsAt?.toISOString() !== source.endsAt
  )
    problems.push("SOURCE_METADATA_CONFLICT");

  const evidence = dateEvidenceSchema.parse({
    sourceKind: candidate.sourceKind,
    sourceUrl: candidate.sourceUrl,
    sourceRecordId: candidate.sourceRecordId,
    sourceRegion: "NA",
    retrievedAt: candidate.retrievedAt,
    contentHash: candidate.contentHash,
    confirmedStartsAt: new Date(source.startsAt),
    confirmedStartPrecision: source.startsAtPrecision,
    confirmedEndsAt: new Date(source.endsAt),
    confirmedEndPrecision: source.endsAtPrecision,
  });
  const current = effectiveEvent(event);
  const ownedEventFields = event.curation?.active
    ? eventCurationFields.filter((field) => ownsField(event.curation!, field))
    : [];
  const nextOwnership = ownedEventFields.filter(
    (field) =>
      !input.useGlobalEventFields.includes(
        field as (typeof eventFields)[number],
      ),
  );
  const nextCuration = event.curation
    ? {
        ...event.curation,
        ownedFields: nextOwnership,
        active: event.curation.active && nextOwnership.length > 0,
      }
    : null;
  const baseline = {
    ...event,
    name: source.globalName,
    startsAt: evidence.confirmedStartsAt!,
    endsAt: evidence.confirmedEndsAt,
    startsAtPrecision: source.startsAtPrecision,
    endsAtPrecision: source.endsAtPrecision,
    curation: nextCuration,
  };
  const next = effectiveEvent(baseline);
  const confirmation = describeDateConfirmation(
    { ...next, curation: nextCuration },
    [{ ...evidence, id: candidate.id, createdAt: candidate.createdAt }],
  );
  if (next.endsAt && next.endsAt < next.startsAt)
    problems.push("INVALID_MIXED_DATE_RANGE");
  const fields = eventFields.map((field) => ({
    field,
    current: current[field],
    source: baseline[field],
    next: next[field],
    owned: ownedEventFields.includes(field),
    keepCorrection: nextOwnership.includes(field),
  }));

  const naRewards = indexSourceRewards(source.embeddedRewardSources);
  const jpRewards = indexSourceRewards(source.jpEmbeddedRewardSources);
  const selectedRewards = new Map(
    input.useGlobalRewardFields.map((value) => [value.rewardId, value.fields]),
  );
  const usedSourceKeys = new Set<string>();
  const rewards = event.rewardSources.flatMap((rewardSource) =>
    rewardSource.rewards.map((reward) => {
      const before = effectiveReward(reward, rewardDateShift(event));
      const originalKey = reward.sourceKey.endsWith(":projection:NA")
        ? reward.sourceKey.slice(0, -":projection:NA".length)
        : null;
      const incoming = originalKey ? naRewards.get(originalKey) : undefined;
      const origin = originalKey ? jpRewards.get(originalKey) : undefined;
      const matched = Boolean(
        incoming?.length === 1 &&
        origin?.length === 1 &&
        incoming[0]!.sourceType === origin[0]!.sourceType &&
        rewardSource.type === origin[0]!.sourceType &&
        reward.itemType === origin[0]!.value.itemType &&
        incoming[0]!.value.itemType === origin[0]!.value.itemType,
      );
      if (!matched)
        return {
          id: reward.id,
          sourceKey: reward.sourceKey,
          matched: false,
          fields: [],
          current: before,
          next: before,
          warning: "NO_VERIFIED_GLOBAL_REWARD",
          nextOwnedFields: reward.curation?.ownedFields ?? [],
        };
      usedSourceKeys.add(originalKey!);
      const incomingReward = incoming![0]!.value;
      const ownedFields = reward.curation?.active
        ? rewardCurationFields.filter((field) =>
            ownsField(reward.curation!, field),
          )
        : [];
      const nextOwnedFields = ownedFields.filter(
        (field) => !selectedRewards.get(reward.id)?.includes(field),
      );
      const curation = reward.curation
        ? {
            ...reward.curation,
            ownedFields: nextOwnedFields,
            active: reward.curation.active && nextOwnedFields.length > 0,
          }
        : null;
      const nextSource = {
        ...reward,
        ...incomingReward,
        id: reward.id,
        sourceKey: reward.sourceKey,
        expectedAt: incomingReward.expectedAt
          ? new Date(incomingReward.expectedAt)
          : null,
        curation,
      };
      const after = effectiveReward(nextSource, rewardDateShift(baseline));
      return {
        id: reward.id,
        sourceKey: reward.sourceKey,
        matched: true,
        fields: rewardCurationFields.map((field) => ({
          field,
          current: before[field],
          source: nextSource[field],
          next: after[field],
          owned: ownedFields.includes(field),
          keepCorrection: nextOwnedFields.includes(field),
        })),
        current: before,
        next: after,
        warning: null,
        nextOwnedFields,
      };
    }),
  );
  for (const choice of input.useGlobalRewardFields)
    if (
      !rewards.some((reward) => reward.id === choice.rewardId && reward.matched)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Only verified rewards from this event can use Global source values.",
      });
    }
  const unmatchedGlobalRewards = [...naRewards.keys()].filter(
    (key) => !usedSourceKeys.has(key),
  );
  const resourceDelta = new Map<string, number>();
  for (const reward of rewards) {
    resourceDelta.set(
      reward.current.itemType,
      (resourceDelta.get(reward.current.itemType) ?? 0) - reward.current.amount,
    );
    resourceDelta.set(
      reward.next.itemType,
      (resourceDelta.get(reward.next.itemType) ?? 0) + reward.next.amount,
    );
  }
  const preview = {
    candidateId: candidate.id,
    eventId: event.id,
    familyId: event.familyId,
    fields,
    nextOwnedFields: nextOwnership,
    rewards,
    unmatchedGlobalRewards,
    resourceDelta: Object.fromEntries(
      [...resourceDelta].filter(([, amount]) => amount !== 0),
    ),
    confirmation,
    hidden: eventIsHidden(event),
    problems,
    ready: !problems.length,
    sourceEvidence: evidence,
    jpEvidence: source.jpEvidence,
    coverageWarning:
      "Quest rewards were not inspected. Unmatched rewards remain unchanged and no new reward is created.",
    published: false as const,
  };
  return {
    ...preview,
    fingerprint: fingerprint({ preview, choices: input, event }),
  };
}

export async function getGlobalEventPreview(
  database: PrismaClient,
  rawInput: unknown,
) {
  const input = globalEventPreviewSchema.parse(rawInput);
  const candidate = await database.globalEventCandidate.findUnique({
    where: { id: input.candidateId },
  });
  if (!candidate?.targetEventId)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This assessment has no verified event target.",
    });
  const [event, latest] = await Promise.all([
    database.event.findUnique({
      relationLoadStrategy: "join",
      where: { id: candidate.targetEventId },
      include: reviewEventInclude,
    }),
    database.globalEventCandidate.findFirst({
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
  return buildGlobalEventPreview(candidate, event, input, latest.id);
}
