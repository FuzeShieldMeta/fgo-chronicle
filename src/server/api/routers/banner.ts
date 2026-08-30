import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

const MAX_BANNER_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000;

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
  upcoming: publicProcedure.input(bannerRangeSchema).query(({ ctx, input }) => {
    return ctx.db.banner.findMany({
      where: {
        startsAt: {
          gte: input.from,
          lte: input.to,
        },
      },
      include: {
        featured: {
          include: {
            servant: true,
          },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
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
          featured: {
            include: {
              servant: true,
            },
          },
        },
      });

      if (!banner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Banner not found.",
        });
      }

      return banner;
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
          featured: {
            include: {
              servant: true,
            },
          },
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });

      const asOf = input.asOf ?? new Date();

      return {
        servant,
        banners: banners.map((banner) => ({
          ...banner,
          timing: getBannerTiming(banner, asOf),
        })),
      };
    }),
});
