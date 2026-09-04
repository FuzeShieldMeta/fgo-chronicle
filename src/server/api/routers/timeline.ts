import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Prisma } from "../../../../generated/prisma";
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

const timelineDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EVENT"), id: z.string().trim().min(1) }),
  z.object({ kind: z.literal("BANNER"), id: z.string().trim().min(1) }),
]);

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
  sourceStartsAt: true,
  sourceEndsAt: true,
  projectionMethod: true,
  lastSyncedAt: true,
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

const relatedEventSelect = {
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
  sourceStartsAt: true,
  sourceEndsAt: true,
  projectionMethod: true,
  lastSyncedAt: true,
  updatedAt: true,
} as const;

const relatedBannerSelect = {
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
} as const;

const familyDetailSelect = {
  ...familySelect,
  events: {
    select: relatedEventSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  },
  banners: {
    select: relatedBannerSelect,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.EventFamilySelect;

const rewardSourceSelect = {
  id: true,
  name: true,
  type: true,
  status: true,
  evidenceUrl: true,
  lastVerifiedAt: true,
  updatedAt: true,
  rewards: {
    select: {
      id: true,
      itemType: true,
      amount: true,
      expectedAt: true,
      nature: true,
      eligibility: true,
      defaultIncluded: true,
      reviewedAt: true,
    },
    orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.RewardSourceSelect;

const incomeContributionSelect = {
  id: true,
  itemType: true,
  amount: true,
  expectedAt: true,
  nature: true,
  eligibility: true,
  defaultIncluded: true,
  reviewedAt: true,
  rewardSource: {
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      evidenceUrl: true,
      event: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
} satisfies Prisma.RewardDefinitionSelect;

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

type RelatedScheduleEntry = {
  id: string;
  name: string;
  startsAt: Date;
  startsAtPrecision: "DATE_ONLY" | "EXACT";
  endsAt: Date | null;
  endsAtPrecision: "DATE_ONLY" | "EXACT" | null;
  status: "PROJECTED" | "CURATED" | "OFFICIAL";
  sourceUrl: string | null;
  sourceRegion: string;
  sourceStartsAt?: Date | null;
  sourceEndsAt?: Date | null;
  projectionMethod?: "TWO_CALENDAR_YEARS" | null;
  lastSyncedAt?: Date | null;
  updatedAt: Date;
};

function relatedEntries(family: {
  events: Array<RelatedScheduleEntry & { type: string }>;
  banners: RelatedScheduleEntry[];
}) {
  return [
    ...family.events.map((event) => ({
      ...event,
      key: `event:${event.id}`,
      kind: "EVENT" as const,
      category: eventCategory(event.type),
      confidence: null,
      sourceLastCheckedAt: event.lastSyncedAt ?? null,
    })),
    ...family.banners.map((banner) => ({
      ...banner,
      key: `banner:${banner.id}`,
      kind: "BANNER" as const,
      category: "SUMMONING_CAMPAIGN" as const,
      confidence: null,
      sourceLastCheckedAt: null,
    })),
  ].sort(compareTimelineEntries);
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
          sourceLastCheckedAt: event.lastSyncedAt,
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
  income: publicProcedure
    .input(timelineRangeSchema)
    .query(async ({ ctx, input }) => {
      const contributions = await ctx.db.rewardDefinition.findMany({
        where: {
          expectedAt: {
            gte: input.from,
            lte: input.to,
          },
        },
        select: incomeContributionSelect,
        orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
      });

      return contributions.flatMap((contribution) =>
        contribution.expectedAt
          ? [{ ...contribution, expectedAt: contribution.expectedAt }]
          : [],
      );
    }),
  details: publicProcedure
    .input(timelineDetailSchema)
    .query(async ({ ctx, input }) => {
      if (input.kind === "BANNER") {
        const banner = await ctx.db.banner.findUnique({
          where: { id: input.id },
          select: {
            ...relatedBannerSelect,
            family: { select: familyDetailSelect },
            featured: {
              select: {
                soloRateUp: true,
                servant: {
                  select: { id: true, name: true, className: true },
                },
              },
              orderBy: [{ servantId: "asc" }],
            },
          },
        });

        if (!banner) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Timeline entry not found.",
          });
        }

        const { family, ...schedule } = banner;

        return {
          ...schedule,
          key: `banner:${banner.id}`,
          kind: "BANNER" as const,
          category: "SUMMONING_CAMPAIGN" as const,
          confidence: null,
          sourceLastCheckedAt: null,
          family: family
            ? {
                id: family.id,
                name: family.name,
                artworkUrl: family.artworkUrl,
                artworkSourceUrl: family.artworkSourceUrl,
                artworkAlt: family.artworkAlt,
                artworkReviewedAt: family.artworkReviewedAt,
              }
            : null,
          relatedEntries: family ? relatedEntries(family) : [],
        };
      }

      const event = await ctx.db.event.findUnique({
        where: { id: input.id },
        select: {
          ...relatedEventSelect,
          family: { select: familyDetailSelect },
          rewardSources: {
            select: rewardSourceSelect,
            orderBy: [{ name: "asc" }, { id: "asc" }],
          },
        },
      });

      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Timeline entry not found.",
        });
      }

      const { family, rewardSources, ...schedule } = event;

      return {
        ...schedule,
        key: `event:${event.id}`,
        kind: "EVENT" as const,
        category: eventCategory(event.type),
        confidence: null,
        sourceLastCheckedAt: event.lastSyncedAt,
        rewardDataStatus:
          rewardSources.length > 0
            ? ("AVAILABLE" as const)
            : ("UNKNOWN" as const),
        rewardSources,
        family: family
          ? {
              id: family.id,
              name: family.name,
              artworkUrl: family.artworkUrl,
              artworkSourceUrl: family.artworkSourceUrl,
              artworkAlt: family.artworkAlt,
              artworkReviewedAt: family.artworkReviewedAt,
            }
          : null,
        relatedEntries: family ? relatedEntries(family) : [],
      };
    }),
});
