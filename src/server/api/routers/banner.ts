import { z } from "zod";
import { TRPCError } from "@trpc/server";

import type { Prisma } from "../../../../generated/prisma";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { effectiveBanner } from "~/server/services/effective-schedule";
import { publicBannerDateOverlaySelect } from "~/server/services/global-baseline-select";

const MAX_BANNER_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000;

const bannerRelations = {
  dateOverlay: publicBannerDateOverlaySelect,
  featured: {
    include: {
      servant: true,
    },
  },
  summonLineups: {
    include: {
      featured: {
        include: { servant: true },
        orderBy: [{ servantId: "asc" }],
      },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.BannerInclude;

function effectiveBannerDetails(
  banner: Prisma.BannerGetPayload<{ include: typeof bannerRelations }>,
) {
  const effective = effectiveBanner(banner);
  const offset = effective.startsAt.getTime() - banner.startsAt.getTime();
  return {
    ...effective,
    summonLineups: effective.summonLineups.map((lineup) => ({
      ...lineup,
      startsAt: new Date(lineup.startsAt.getTime() + offset),
      endsAt: lineup.endsAt ? new Date(lineup.endsAt.getTime() + offset) : null,
    })),
  };
}

const bannerRangeSchema = z
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

    if (to.getTime() - from.getTime() > MAX_BANNER_RANGE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The date range cannot exceed three years.",
        path: ["to"],
      });
    }
  });

function getBannerTiming(
  banner: {
    startsAt: Date;
    endsAt: Date | null;
    status: "PROJECTED" | "CURATED" | "OFFICIAL";
  },
  asOf: Date,
) {
  if (banner.endsAt && banner.endsAt <= asOf) {
    return "PAST" as const;
  }

  if (banner.startsAt <= asOf) {
    return "ACTIVE" as const;
  }

  return banner.status === "PROJECTED"
    ? ("PROJECTED_FUTURE" as const)
    : ("CONFIRMED_FUTURE" as const);
}

export const bannerRouter = createTRPCRouter({
  upcoming: publicProcedure
    .input(bannerRangeSchema)
    .query(async ({ ctx, input }) => {
      const banners = await ctx.db.banner.findMany({
        where: {
          OR: [
            { startsAt: { gte: input.from, lte: input.to } },
            {
              dateOverlay: {
                is: { startsAt: { gte: input.from, lte: input.to } },
              },
            },
          ],
        },
        include: {
          ...bannerRelations,
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });
      return banners
        .map(effectiveBannerDetails)
        .filter(
          (banner) =>
            banner.startsAt >= input.from && banner.startsAt <= input.to,
        )
        .sort(
          (a, b) =>
            a.startsAt.getTime() - b.startsAt.getTime() ||
            a.id.localeCompare(b.id),
        );
    }),
  byId: publicProcedure
    .input(
      z.object({
        id: z.string().trim().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const banner = await ctx.db.banner.findUnique({
        where: {
          id: input.id,
        },
        include: {
          ...bannerRelations,
        },
      });

      if (!banner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Banner not found.",
        });
      }

      return effectiveBannerDetails(banner);
    }),
  searchServants: publicProcedure
    .input(
      z.object({
        query: z.string().trim().min(1).max(100),
        limit: z.number().int().min(1).max(25).default(10),
      }),
    )
    .query(({ ctx, input }) => {
      return ctx.db.servant.findMany({
        where: {
          name: {
            contains: input.query,
            mode: "insensitive",
          },
        },
        select: {
          id: true,
          name: true,
          className: true,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: input.limit,
      });
    }),
  bannersForServant: publicProcedure
    .input(
      z.object({
        servantId: z.number().int().positive(),
        asOf: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const servant = await ctx.db.servant.findUnique({
        where: {
          id: input.servantId,
        },
        select: {
          id: true,
          name: true,
          className: true,
        },
      });

      if (!servant) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Servant not found.",
        });
      }

      const banners = await ctx.db.banner.findMany({
        where: {
          featured: {
            some: {
              servantId: input.servantId,
            },
          },
        },
        include: {
          ...bannerRelations,
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });

      const asOf = input.asOf ?? new Date();

      return {
        servant,
        banners: banners.map(effectiveBannerDetails).map((banner) => ({
          ...banner,
          timing: getBannerTiming(banner, asOf),
        })),
      };
    }),
});
