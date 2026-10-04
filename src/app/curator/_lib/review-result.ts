import type { RouterOutputs } from "~/trpc/react";

type EventDetail = RouterOutputs["curator"]["event"];
export type ReviewResult = RouterOutputs["curator"]["review"];

// A background fetch may already contain newer content. Do not mark it reviewed.
export function applyReviewResult(
  event: EventDetail,
  result: ReviewResult,
): EventDetail {
  if (event.id !== result.eventId) return event;
  const updates = new Map(
    result.reviews.map((review) => [
      `${review.snapshot.targetKind}:${review.snapshot.targetId}`,
      review,
    ]),
  );
  function update(review: EventDetail["review"]) {
    const next = updates.get(
      `${review.snapshot.targetKind}:${review.snapshot.targetId}`,
    );
    if (!next) return review;
    return next.snapshot.sourceHash === review.snapshot.sourceHash &&
      next.snapshot.effectiveHash === review.snapshot.effectiveHash &&
      (!review.reviewedAt ||
        (next.reviewedAt?.getTime() ?? 0) >= review.reviewedAt.getTime())
      ? next
      : review;
  }
  return {
    ...event,
    review: update(event.review),
    rewardSources: event.rewardSources.map((source) => ({
      ...source,
      rewards: source.rewards.map((reward) => ({
        ...reward,
        review: update(reward.review),
      })),
    })),
  };
}
