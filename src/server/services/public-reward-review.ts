import { rewardReviewSnapshotForSource, reviewState } from "./curator-review";
import {
  effectiveEvent,
  effectiveReward,
  rewardDateShift,
} from "./effective-schedule";
import { ownsField } from "./curation-ownership";

export const publicRewardReviewSelect = {
  select: { sourceHash: true, effectiveHash: true, createdAt: true },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: 1,
};

export function publicReward<
  T extends Parameters<typeof rewardReviewSnapshotForSource>[0] & {
    dateBasis?: "UNKNOWN" | "EVENT_END" | "START_RELATIVE" | "ABSOLUTE";
    reviews?: Array<{
      sourceHash: string;
      effectiveHash: string;
      createdAt: Date;
    }>;
  },
>(
  reward: T,
  source: Parameters<typeof rewardReviewSnapshotForSource>[1],
  event: Parameters<typeof effectiveEvent>[0] | null,
) {
  const state = reviewState(
    rewardReviewSnapshotForSource(reward, source, event),
    reward.reviews ?? [],
  );
  const {
    reviews: _reviews,
    rewardSourceId: _sourceId,
    ...effective
  } = effectiveReward(reward, rewardDateShift(event, reward));
  void _reviews;
  void _sourceId;
  const endBound =
    reward.dateBasis === "EVENT_END" &&
    !(reward.curation?.active && ownsField(reward.curation, "expectedAt"));
  const expectedAtPrecision =
    endBound && event?.endsAt
      ? (effectiveEvent(event).endsAtPrecision ?? "EXACT")
      : "EXACT";
  return {
    ...effective,
    expectedAtPrecision,
    reviewStatus: state.status,
    reviewedAt: state.status === "REVIEWED" ? state.reviewedAt : null,
  };
}
