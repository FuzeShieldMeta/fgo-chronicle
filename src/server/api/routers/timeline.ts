import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

const MAX_TIMELINE_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000;
const timelineCategories = [
  "EVENT",
  "SUMMONING_CAMPAIGN",
  "INCOME_SOURCE",
] as const;
const scheduleStatuses = ["PROJECTED", "CURATED", "OFFICIAL"] as const;
const incomeSourceEventTypes = [
  "LOGIN_BONUS",
  "EVENT_SHOP",
  "LIMITED_MISSION",
  "MAINTENANCE",
] as const;

const timelineRangeSchema = z
  .object({
    from: z.date(),
    to: z.date(),
    categories: z.array(z.enum(timelineCategories)).min(1).max(3).optional(),
    statuses: z.array(z.enum(scheduleStatuses)).min(1).max(3).optional(),
    sourceRegions: z
      .array(z.string().trim().min(1).max(50))
      .min(1)
      .max(10)
      .optional(),
    servantId: z.number().int().positive().optional(),
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

function eventCategory(eventType: string) {
  return incomeSourceEventTypes.some((type) => type === eventType)
    ? ("INCOME_SOURCE" as const)
    : ("EVENT" as const);
}

function intervalWhere(from: Date, to: Date) {
  return {
    startsAt: { lte: to },
    OR: [{ endsAt: { gte: from } }, { endsAt: null, startsAt: { gte: from } }],
  };
}

type TimelineListInput = z.infer<typeof timelineRangeSchema>;

function commonWhere(input: TimelineListInput) {
  return {
    ...intervalWhere(input.from, input.to),
    ...(input.statuses ? { status: { in: input.statuses } } : {}),
    ...(input.sourceRegions
      ? { sourceRegion: { in: input.sourceRegions } }
      : {}),
  };
}

function selectedCategory(
  categories: TimelineListInput["categories"],
  category: (typeof timelineCategories)[number],
) {
  return categories === undefined || categories.includes(category);
}

function eventTypeWhere(categories: TimelineListInput["categories"]) {
  const includesEvents = selectedCategory(categories, "EVENT");
  const includesIncome = selectedCategory(categories, "INCOME_SOURCE");

  if (includesEvents === includesIncome) {
    return {};
  }

  return includesIncome
    ? { type: { in: [...incomeSourceEventTypes] } }
    : { type: { notIn: [...incomeSourceEventTypes] } };
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
      const includeEvents =
        input.servantId === undefined &&
        (selectedCategory(input.categories, "EVENT") ||
          selectedCategory(input.categories, "INCOME_SOURCE"));
      const includeBanners = selectedCategory(
        input.categories,
        "SUMMONING_CAMPAIGN",
      );
      const [events, banners] = await Promise.all([
        includeEvents
          ? ctx.db.event.findMany({
              where: {
                ...commonWhere(input),
                ...eventTypeWhere(input.categories),
              },
              select: eventSelect,
              orderBy: [{ startsAt: "asc" }, { id: "asc" }],
            })
          : Promise.resolve([]),
        includeBanners
          ? ctx.db.banner.findMany({
              where: {
                ...commonWhere(input),
                ...(input.servantId
                  ? { featured: { some: { servantId: input.servantId } } }
                  : {}),
              },
              select: bannerSelect,
              orderBy: [{ startsAt: "asc" }, { id: "asc" }],
            })
          : Promise.resolve([]),
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
