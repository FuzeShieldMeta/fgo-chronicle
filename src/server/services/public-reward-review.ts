import { rewardReviewSnapshotForSource, reviewState } from "./curator-review";
import { effectiveReward, rewardDateShift } from "./effective-schedule";

export const publicRewardReviewSelect = {
  select: { sourceHash: true, effectiveHash: true, createdAt: true },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: 1,
};

export function publicReward<
  T extends Parameters<typeof rewardReviewSnapshotForSource>[0] & {
    reviews?: Array<{
      sourceHash: string;
      effectiveHash: string;
      createdAt: Date;
    }>;
  },
>(
  reward: T,
  source: Parameters<typeof rewardReviewSnapshotForSource>[1],
  event: Parameters<typeof rewardDateShift>[0],
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
  return {
    ...effective,
    reviewStatus: state.status,
    reviewedAt: state.status === "REVIEWED" ? state.reviewedAt : null,
  };
}
