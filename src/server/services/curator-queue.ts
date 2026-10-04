import { z } from "zod";
import { describeEventReview, type ReviewEvent } from "./curator-review";
import { effectiveEvent, eventIsHidden } from "./effective-schedule";

export const curatorQueueSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    page: z.number().int().min(0).max(10000).default(0),
    view: z
      .enum([
        "ALL",
        "UNREVIEWED",
        "NEEDS_REVIEW",
        "SOURCE_CHANGED",
        "MISSING_EVIDENCE",
        "CORRECTED",
        "HIDDEN",
      ])
      .default("ALL"),
    sort: z
      .enum(["EARLIEST", "LATEST", "EARLIEST_UNREVIEWED"])
      .default("EARLIEST_UNREVIEWED"),
    visibility: z.enum(["VISIBLE", "ALL", "HIDDEN"]).default("VISIBLE"),
    type: z
      .enum([
        "MAIN_EVENT",
        "PRE_RELEASE_CAMPAIGN",
        "LOGIN_BONUS",
        "CAMPAIGN",
        "EVENT_SHOP",
        "QUEST_RELEASE",
        "LIMITED_MISSION",
        "MAINTENANCE",
        "OTHER",
      ])
      .optional(),
    status: z.enum(["PROJECTED", "CURATED", "OFFICIAL"]).optional(),
    from: z.date().optional(),
    to: z.date().optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The end must not precede the start.",
    path: ["to"],
  });

export function buildCuratorQueue(
  events: ReviewEvent[],
  input: z.infer<typeof curatorQueueSchema>,
) {
  const search = input.search.toLocaleLowerCase("en");
  const rows = events
    .map((event) => {
      const detail = describeEventReview(event);
      const schedule = effectiveEvent(event);
      const rewards = detail.rewardSources.flatMap((source) => source.rewards);
      const states = [detail.review, ...rewards.map((reward) => reward.review)];
      const missingEvidence =
        !event.sourceUrl?.trim() ||
        event.rewardSources.some((source) => !source.evidenceUrl.trim());
      const badges = [
        ...(states.some((state) => state.status === "UNREVIEWED")
          ? ["UNREVIEWED" as const]
          : []),
        ...(states.some((state) => state.status === "NEEDS_REVIEW")
          ? ["NEEDS_REVIEW" as const]
          : []),
        ...(states.some((state) => state.sourceChanged)
          ? ["SOURCE_CHANGED" as const]
          : []),
        ...(missingEvidence ? ["MISSING_EVIDENCE" as const] : []),
        ...(event.curation?.active ||
        rewards.some((reward) => reward.curation?.active)
          ? ["CORRECTED" as const]
          : []),
        ...(eventIsHidden(event) ? ["HIDDEN" as const] : []),
      ];
      return {
        id: event.id,
        name: schedule.name,
        sourceName: event.name,
        startsAt: schedule.startsAt,
        endsAt: schedule.endsAt,
        type: event.type,
        status: schedule.status,
        hidden: eventIsHidden(event),
        badges,
        eventReview: detail.review.status,
        rewardCounts: {
          total: rewards.length,
          reviewed: rewards.filter(
            (reward) => reward.review.status === "REVIEWED",
          ).length,
          unreviewed: rewards.filter(
            (reward) => reward.review.status === "UNREVIEWED",
          ).length,
          needsReview: rewards.filter(
            (reward) => reward.review.status === "NEEDS_REVIEW",
          ).length,
        },
      };
    })
    .filter((row) => {
      const outstanding =
        row.eventReview !== "REVIEWED" ||
        row.rewardCounts.reviewed !== row.rewardCounts.total;
      return (
        (!search ||
          row.name.toLocaleLowerCase("en").includes(search) ||
          row.sourceName.toLocaleLowerCase("en").includes(search)) &&
        (input.view === "ALL" || row.badges.includes(input.view)) &&
        (input.view === "HIDDEN" ||
          input.visibility === "ALL" ||
          row.hidden === (input.visibility === "HIDDEN")) &&
        (!input.type || row.type === input.type) &&
        (!input.status || row.status === input.status) &&
        (!input.from || (row.endsAt ?? row.startsAt) >= input.from) &&
        (!input.to || row.startsAt <= input.to) &&
        (input.sort !== "EARLIEST_UNREVIEWED" || outstanding)
      );
    })
    .sort((a, b) => {
      const difference = a.startsAt.getTime() - b.startsAt.getTime();
      return (
        (input.sort === "LATEST" ? -difference : difference) ||
        a.id.localeCompare(b.id, "en")
      );
    });
  return {
    events: rows.slice(input.page * 25, (input.page + 1) * 25),
    count: rows.length,
  };
}
