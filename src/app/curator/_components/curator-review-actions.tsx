"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import type { ReviewResult } from "../_lib/review-result";

type EventDetail = RouterOutputs["curator"]["event"];
type Reward = EventDetail["rewardSources"][number]["rewards"][number];
export const reviewLabel = (status: string) =>
  status === "REVIEWED"
    ? "Reviewed"
    : status === "NEEDS_REVIEW"
      ? "Needs re-review"
      : "Unreviewed";

export function CuratorReviewActions({
  event,
  reward,
  dirty,
  onReviewed,
}: {
  event: EventDetail;
  reward?: Reward;
  dirty: boolean;
  onReviewed: (result: ReviewResult, notice: string) => void;
}) {
  const [notice, setNotice] = useState("");
  const mutation = api.curator.review.useMutation({
    onSuccess: (result) => {
      onReviewed(
        result,
        `Reviewed ${result.reviewedCount} ${result.reviewedCount === 1 ? "record" : "records"}.`,
      );
    },
    onError: (error) => setNotice(error.message),
  });
  const selected = reward?.review ?? event.review;
  const rewards = event.rewardSources.flatMap((source) => source.rewards);
  const reviewedRewards = rewards.filter(
    (value) => value.review.status === "REVIEWED",
  ).length;
  function review(all: boolean) {
    setNotice("");
    mutation.mutate({
      eventId: event.id,
      scope: all ? "ALL" : reward ? "REWARD" : "EVENT",
      snapshots: all
        ? [
            event.review.snapshot,
            ...rewards.map((value) => value.review.snapshot),
          ]
        : [selected.snapshot],
    });
  }
  return (
    <section
      className="curator-review"
      aria-label="Review status"
      aria-busy={mutation.isPending}
    >
      <h3>Review</h3>
      <p>
        {reward ? "Reward" : "Event"}: {reviewLabel(selected.status)}
        {selected.sourceChanged ? " · Source changed" : ""}
      </p>
      {!reward && (
        <p>
          Rewards: {reviewedRewards} of {rewards.length} reviewed.
        </p>
      )}
      {selected.reviewedAt && (
        <p>
          Last review:{" "}
          {selected.reviewedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
        </p>
      )}
      {reward?.reviewedAt && !selected.reviewedAt && (
        <p>
          Older review date: {reward.reviewedAt.toISOString().slice(0, 10)}.
          Check the current values before marking this reward reviewed.
        </p>
      )}
      <div className="curator-actions">
        <button
          type="button"
          disabled={
            dirty || mutation.isPending || selected.status === "REVIEWED"
          }
          onClick={() => review(false)}
        >
          {mutation.isPending ? "Saving review…" : "Mark reviewed"}
        </button>
        {!reward && (
          <button
            type="button"
            disabled={
              dirty ||
              mutation.isPending ||
              (selected.status === "REVIEWED" &&
                reviewedRewards === rewards.length)
            }
            onClick={() => review(true)}
          >
            Review all
          </button>
        )}
      </div>
      {!reward && <p>Review all covers this event and its current rewards.</p>}
      {dirty && <p>Save or discard your edits before reviewing.</p>}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
