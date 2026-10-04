import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { GlobalEventCandidate } from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import type { ReviewEvent } from "./curator-review";
import {
  buildGlobalEventPreview,
  globalEventPreviewSchema,
  readGlobalEventSnapshot,
} from "./global-event-preview";

export const globalPublicationInputSchema = z
  .object({
    preview: globalEventPreviewSchema,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z
      .string()
      .trim()
      .min(GLOBAL_SOURCE_LIMITS.minPublicationReasonLength)
      .max(GLOBAL_SOURCE_LIMITS.maxPublicationReasonLength),
  })
  .strict();

// Call under publication locks with freshly read records, not client preview data.
export function buildGlobalPublicationPlan(
  candidate: GlobalEventCandidate,
  event: ReviewEvent,
  rawInput: unknown,
  latestCandidateId: string,
) {
  const input = globalPublicationInputSchema.parse(rawInput);
  if (input.preview.candidateId !== candidate.id)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The preview belongs to a different source assessment.",
    });
  const preview = buildGlobalEventPreview(
    candidate,
    event,
    input.preview,
    latestCandidateId,
  );
  if (!preview.ready)
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This source assessment cannot be published. Collect and preview it again.",
    });
  if (preview.fingerprint !== input.expectedFingerprint)
    throw new TRPCError({
      code: "CONFLICT",
      message: "The event or source changed. Preview the changes again.",
    });

  const snapshot = readGlobalEventSnapshot(candidate);
  const sourceRewards = new Map(
    snapshot.embeddedRewardSources.flatMap((source) =>
      source.rewards.map((reward) => [reward.sourceKey, reward] as const),
    ),
  );
  const rewardRecords = new Map(
    event.rewardSources.flatMap((source) =>
      source.rewards.map((reward) => [reward.id, reward] as const),
    ),
  );
  const eventBaseline = {
    name: snapshot.globalName,
    startsAt: new Date(snapshot.startsAt),
    endsAt: new Date(snapshot.endsAt),
    startsAtPrecision: snapshot.startsAtPrecision,
    endsAtPrecision: snapshot.endsAtPrecision,
  };
  const rewardBaselines = preview.rewards
    .filter((reward) => reward.matched)
    .map((reward) => {
      const sourceKey = reward.sourceKey.slice(0, -":projection:NA".length);
      const source = sourceRewards.get(sourceKey)!;
      const record = rewardRecords.get(reward.id)!;
      return {
        rewardId: record.id,
        sourceKey: record.sourceKey,
        rewardSourceId: record.rewardSourceId,
        itemType: source.itemType,
        amount: source.amount,
        expectedAt: source.expectedAt ? new Date(source.expectedAt) : null,
        nature: source.nature,
        eligibility: source.eligibility,
        defaultIncluded: source.defaultIncluded,
      };
    })
    .sort((a, b) => a.rewardId.localeCompare(b.rewardId));
  const ownershipChanges = [
    ...(event.curation?.active &&
    event.curation.ownedFields.length !== preview.nextOwnedFields.length
      ? [
          {
            targetKind: "EVENT" as const,
            targetId: event.id,
            expectedRevision: event.curation.revision,
            ownedFields: preview.nextOwnedFields,
            active: preview.nextOwnedFields.length > 0,
          },
        ]
      : []),
    ...preview.rewards.flatMap((reward) => {
      const curation = rewardRecords.get(reward.id)?.curation;
      return reward.matched &&
        curation?.active &&
        curation.ownedFields.length !== reward.nextOwnedFields.length
        ? [
            {
              targetKind: "REWARD" as const,
              targetId: reward.id,
              expectedRevision: curation.revision,
              ownedFields: reward.nextOwnedFields,
              active: reward.nextOwnedFields.length > 0,
            },
          ]
        : [];
    }),
  ];
  const baselineHash = createHash("sha256")
    .update(
      JSON.stringify({
        eventId: event.id,
        sourceKey: event.sourceKey,
        eventBaseline,
        rewardBaselines,
        contentHash: candidate.contentHash,
        assessmentHash: candidate.assessmentHash,
      }),
    )
    .digest("hex");
  return {
    eventId: event.id,
    eventSourceKey: event.sourceKey,
    candidateId: candidate.id,
    baselineHash,
    eventBaseline,
    rewardBaselines,
    ownershipChanges,
    evidence: preview.sourceEvidence,
    reason: input.reason,
  };
}
