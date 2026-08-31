import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

const MAX_TIMELINE_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000;

const timelineRangeSchema = z
  .object({
    from: z.date(),
    to: z.date(),
  })
  .superRefine(({ from, to }, ctx) => {
    if (to < from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The end date must be on or after the start date.",
        path: ["to"],
      });
    }

    if (to.getTime() - from.getTime() > MAX_TIMELINE_RANGE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The date range cannot exceed three years.",
        path: ["to"],
      });
    }
  });

const familySelect = {
  id: true,
  name: true,
  artworkUrl: true,
  artworkSourceUrl: true,
  artworkAlt: true,
  artworkReviewedAt: true,
} as const;

const eventSelect = {
  id: true,
  name: true,
  type: true,
  startsAt: true,
  startsAtPrecision: true,
  endsAt: true,
  endsAtPrecision: true,
  status: true,
  sourceUrl: true,
  sourceRegion: true,
  updatedAt: true,
  family: { select: familySelect },
} as const;

const bannerSelect = {
  id: true,
  name: true,
  startsAt: true,
  startsAtPrecision: true,
  endsAt: true,
  endsAtPrecision: true,
  status: true,
  sourceUrl: true,
  sourceRegion: true,
  updatedAt: true,
  family: { select: familySelect },
} as const;

const incomeSourceEventTypes = new Set([
  "LOGIN_BONUS",
  "EVENT_SHOP",
  "LIMITED_MISSION",
  "MAINTENANCE",
]);

function eventCategory(eventType: string) {
  return incomeSourceEventTypes.has(eventType)
    ? ("INCOME_SOURCE" as const)
    : ("EVENT" as const);
}

function intervalWhere(from: Date, to: Date) {
  return {
    startsAt: { lte: to },
    OR: [{ endsAt: { gte: from } }, { endsAt: null, startsAt: { gte: from } }],
  };
}

function compareTimelineEntries(
  left: { startsAt: Date; kind: string; id: string },
  right: { startsAt: Date; kind: string; id: string },
) {
  return (
    left.startsAt.getTime() - right.startsAt.getTime() ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

export const timelineRouter = createTRPCRouter({
  list: publicProcedure
    .input(timelineRangeSchema)
    .query(async ({ ctx, input }) => {
      const where = intervalWhere(input.from, input.to);
      const [events, banners] = await Promise.all([
        ctx.db.event.findMany({
          where,
          select: eventSelect,
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        }),
        ctx.db.banner.findMany({
          where,
          select: bannerSelect,
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        }),
      ]);

      return [
        ...events.map((event) => ({
          ...event,
          key: `event:${event.id}`,
          kind: "EVENT" as const,
          category: eventCategory(event.type),
          confidence: null,
        })),
        ...banners.map((banner) => ({
          ...banner,
          key: `banner:${banner.id}`,
          kind: "BANNER" as const,
          category: "SUMMONING_CAMPAIGN" as const,
          confidence: null,
        })),
      ].sort(compareTimelineEntries);
    }),
});
