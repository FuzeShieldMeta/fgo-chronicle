import { z } from "zod";

import {
  createTRPCRouter,
  publicProcedure,
} from "~/server/api/trpc";

export const bannerRouter = createTRPCRouter({
  upcoming: publicProcedure
    .input(
      z.object({
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(({ ctx, input }) => {
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
        orderBy: {
          startsAt: "asc",
        },
      });
    }),
});