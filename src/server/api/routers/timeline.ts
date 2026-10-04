import storyChapters from "~/data/story-chapters.json";
import { TRPCError } from "@trpc/server";
import { unstable_cache } from "next/cache";
import superjson from "superjson";
import { z } from "zod";

import type { Prisma } from "../../../../generated/prisma";
import { timelineWindowAt } from "~/app/timeline/_lib/progressive-timeline";
import { timelineSchedule } from "~/app/timeline/_lib/timeline-layout-config";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { ownsField } from "~/server/services/curation-ownership";
import {
  publicReward,
  publicRewardReviewSelect,
} from "~/server/services/public-reward-review";
import {
  effectiveEvent,
  effectiveFamily,
  eventIsHidden,
  overlapsRange,
} from "~/server/services/effective-schedule";

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

const timelineWindowSchema = z
  .object({
    scheduleStartDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    index: z.number().int().nonnegative(),
  })
  .superRefine(({ scheduleStartDay, index }, ctx) => {
    const start = Date.parse(`${scheduleStartDay}T00:00:00.000Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const distanceFromToday = Math.abs(start - today.getTime());

    if (
      !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== scheduleStartDay ||
      distanceFromToday > 2 * 24 * 60 * 60 * 1_000
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The schedule start date is outside the current timeline.",
        path: ["scheduleStartDay"],
      });
      return;
    }

    try {
      timelineWindowAt(scheduleStartDay, index);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The requested window is outside the two-year schedule.",
        path: ["index"],
      });
    }
  });

export function parseTimelineWindowInput(input: unknown) {
  return timelineWindowSchema.safeParse(input);
}

const familySelect = {
  curation: { select: { active: true, name: true } },
  id: true,
  name: true,
  artworkUrl: true,
  artworkSourceUrl: true,
  artworkAlt: true,
  artworkReviewedAt: true,
} as const;

const eventSelect = {
  curation: true,
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
  curation: true,
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
      curation: true,
      reviews: publicRewardReviewSelect,
      rewardSourceId: true,
      id: true,
      itemType: true,
      amount: true,
      expectedAt: true,
      nature: true,
      eligibility: true,
      storyWarId: true,
      storyReleaseAt: true,
      defaultIncluded: true,
      reviewedAt: true,
    },
    orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.RewardSourceSelect;

const incomeContributionSelect = {
  curation: true,
  reviews: publicRewardReviewSelect,
  rewardSourceId: true,
  id: true,
  itemType: true,
  amount: true,
  expectedAt: true,
  nature: true,
  eligibility: true,
  storyWarId: true,
  storyReleaseAt: true,
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
          startsAt: true,
          curation: true,
        },
      },
    },
  },
} satisfies Prisma.RewardDefinitionSelect;

const summonLineupSelect = {
  id: true,
  sourceKey: true,
  name: true,
  startsAt: true,
  endsAt: true,
  evidenceUrl: true,
  sourceRegion: true,
  lastVerifiedAt: true,
  featured: {
    select: {
      soloRateUp: true,
      servant: {
        select: { id: true, name: true, className: true, rarity: true },
      },
    },
    orderBy: [{ servantId: "asc" }],
  },
} satisfies Prisma.SummonLineupSelect;

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

type TimelineDatabase = Pick<
  typeof db,
  "banner" | "event" | "rewardDefinition" | "storyChapter"
>;

type CachedTimelineListInput = Omit<TimelineListInput, "from" | "to"> & {
  from: string;
  to: string;
};

function cacheInput(input: TimelineListInput): CachedTimelineListInput {
  return {
    ...input,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
  };
}

function restoreCacheInput(input: CachedTimelineListInput): TimelineListInput {
  return {
    ...input,
    from: new Date(input.from),
    to: new Date(input.to),
  };
}

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
  curation?: Prisma.EventCurationGetPayload<Record<string, never>> | null;
};

function relatedEntries(family: {
  events: Array<RelatedScheduleEntry & { type: string }>;
  banners: RelatedScheduleEntry[];
}) {
  return [
    ...family.events
      .filter((event) => !eventIsHidden(event))
      .map((event) => ({
        ...effectiveEvent(event),
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

async function queryStories(database: TimelineDatabase) {
  const chapters = await database.storyChapter.findMany({
    orderBy: [{ sortOrder: "asc" }, { warId: "asc" }],
  });
  return chapters.length ? chapters : storyChapters;
}

async function queryTimelineList(
  database: TimelineDatabase,
  input: TimelineListInput,
) {
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
      ? database.event.findMany({
          relationLoadStrategy: "join",
          where: {
            OR: [
              intervalWhere(input.from, input.to),
              { curation: { is: { active: true } } },
            ],
            ...(input.sourceRegions
              ? { sourceRegion: { in: input.sourceRegions } }
              : {}),
            ...eventTypeWhere(input.categories),
          },
          select: eventSelect,
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
    includeBanners
      ? database.banner.findMany({
          relationLoadStrategy: "join",
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
    ...events
      .filter((event) => !eventIsHidden(event))
      .map(effectiveEvent)
      .filter(
        (event) =>
          overlapsRange(event, input.from, input.to) &&
          (!input.statuses || input.statuses.includes(event.status)),
      )
      .map((event) => ({
        ...event,
        family: event.family ? effectiveFamily(event.family) : null,
        key: `event:${event.id}`,
        kind: "EVENT" as const,
        category: eventCategory(event.type),
        confidence: null,
        sourceLastCheckedAt: event.lastSyncedAt,
      })),
    ...banners.map((banner) => ({
      ...banner,
      family: banner.family ? effectiveFamily(banner.family) : null,
      key: `banner:${banner.id}`,
      kind: "BANNER" as const,
      category: "SUMMONING_CAMPAIGN" as const,
      confidence: null,
    })),
  ].sort(compareTimelineEntries);
}

async function queryIncome(
  database: TimelineDatabase,
  input: TimelineListInput,
) {
  const contributions = await database.rewardDefinition.findMany({
    relationLoadStrategy: "join",
    where: {
      OR: [
        { expectedAt: { gte: input.from, lte: input.to } },
        { curation: { is: { active: true } } },
        { rewardSource: { event: { curation: { is: { active: true } } } } },
      ],
    },
    select: incomeContributionSelect,
    orderBy: [{ expectedAt: "asc" }, { id: "asc" }],
  });

  return contributions
    .flatMap((contribution) => {
      const event = contribution.rewardSource.event;
      if (event && eventIsHidden(event)) return [];
      const effective = publicReward(
        contribution,
        contribution.rewardSource,
        event,
      );
      if (
        !effective.expectedAt ||
        effective.expectedAt < input.from ||
        effective.expectedAt > input.to
      )
        return [];
      return [
        {
          ...effective,
          expectedAt: effective.expectedAt,
          rewardSource: {
            ...effective.rewardSource,
            status: contribution.curation?.active
              ? ("CURATED" as const)
              : contribution.rewardSource.status,
            event: event
              ? {
                  id: event.id,
                  name:
                    event.curation?.active && ownsField(event.curation, "name")
                      ? event.curation.name
                      : event.name,
                }
              : null,
          },
        },
      ];
    })
    .sort(
      (a, b) =>
        a.expectedAt.getTime() - b.expectedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
}

type TimelineWindowInput = z.infer<typeof timelineWindowSchema>;

function timelineWindowRange(input: TimelineWindowInput) {
  const definition = timelineWindowAt(input.scheduleStartDay, input.index);
  const from = new Date(`${definition.fromDay}T00:00:00.000Z`);
  from.setUTCDate(
    from.getUTCDate() - timelineSchedule.queryBoundaryPaddingDays,
  );
  const to = new Date(`${definition.throughDay}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + timelineSchedule.queryBoundaryPaddingDays);
  return { definition, range: { from, to } };
}

async function queryTimelineWindow(
  database: TimelineDatabase,
  input: TimelineWindowInput,
) {
  const { definition, range } = timelineWindowRange(input);
  const [entries, incomeContributions] = await Promise.all([
    queryTimelineList(database, range),
    queryIncome(database, range),
  ]);

  return { ...definition, entries, incomeContributions };
}

const publicTimelineCacheOptions = {
  revalidate: 60 * 60,
  tags: ["timeline-public-data"],
};

const cachedStoriesPayload = unstable_cache(
  async () => superjson.stringify(await queryStories(db)),
  ["timeline-stories-v1"],
  publicTimelineCacheOptions,
);

const cachedTimelineListPayload = unstable_cache(
  async (input: CachedTimelineListInput, _curatorRevision: number) =>
    superjson.stringify(await queryTimelineList(db, restoreCacheInput(input))),
  ["timeline-list-v2"],
  publicTimelineCacheOptions,
);

const cachedIncomePayload = unstable_cache(
  async (input: CachedTimelineListInput, _curatorRevision: number) =>
    superjson.stringify(await queryIncome(db, restoreCacheInput(input))),
  ["timeline-income-v3"],
  publicTimelineCacheOptions,
);

const cachedTimelineWindowPayload = unstable_cache(
  async (input: TimelineWindowInput, _curatorRevision: number) =>
    superjson.stringify(await queryTimelineWindow(db, input)),
  ["timeline-window-v3"],
  publicTimelineCacheOptions,
);

export async function getCachedTimelineStories() {
  return superjson.parse<Awaited<ReturnType<typeof queryStories>>>(
    await cachedStoriesPayload(),
  );
}

async function getCuratorRevision() {
  // Keep this outside unstable_cache: missed tag invalidation must not hide edits.
  // Audit rows are appended in the same transaction as corrections and resets.
  return db.curatorChange.count({
    where: { targetKind: { in: ["EVENT", "REWARD", "FAMILY"] } },
  });
}

export async function getCachedTimelineList(input: TimelineListInput) {
  return superjson.parse<Awaited<ReturnType<typeof queryTimelineList>>>(
    await cachedTimelineListPayload(
      cacheInput(input),
      await getCuratorRevision(),
    ),
  );
}

export async function getCachedTimelineIncome(input: TimelineListInput) {
  return superjson.parse<Awaited<ReturnType<typeof queryIncome>>>(
    await cachedIncomePayload(cacheInput(input), await getCuratorRevision()),
  );
}

export async function getCachedTimelineWindow(input: TimelineWindowInput) {
  return superjson.parse<Awaited<ReturnType<typeof queryTimelineWindow>>>(
    await cachedTimelineWindowPayload(input, await getCuratorRevision()),
  );
}

export const timelineRouter = createTRPCRouter({
  stories: publicProcedure.query(async ({ ctx }) => {
    return queryStories(ctx.db);
  }),
  list: publicProcedure
    .input(timelineRangeSchema)
    .query(async ({ ctx, input }) => {
      return queryTimelineList(ctx.db, input);
    }),
  income: publicProcedure
    .input(timelineRangeSchema)
    .query(async ({ ctx, input }) => {
      return queryIncome(ctx.db, input);
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
                  select: {
                    id: true,
                    name: true,
                    className: true,
                    rarity: true,
                  },
                },
              },
              orderBy: [{ servantId: "asc" }],
            },
            summonLineups: {
              select: summonLineupSelect,
              orderBy: [{ startsAt: "asc" }, { id: "asc" }],
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
                name: effectiveFamily(family).name,
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

      if (!event || eventIsHidden(event)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Timeline entry not found.",
        });
      }

      const { family, rewardSources, ...schedule } = effectiveEvent(event);

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
        rewardSources: rewardSources.map((source) => ({
          ...source,
          status: source.rewards.some((reward) => reward.curation?.active)
            ? ("CURATED" as const)
            : source.status,
          rewards: source.rewards.map((reward) =>
            publicReward(reward, source, event),
          ),
        })),
        family: family
          ? {
              id: family.id,
              name: effectiveFamily(family).name,
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
