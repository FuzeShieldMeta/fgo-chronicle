import { z } from "zod";
import { revalidateTag } from "next/cache";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, curatorProcedure } from "~/server/api/trpc";
import { curationChangeSchema, saveCuration } from "~/server/services/curation";

export const curatorRouter = createTRPCRouter({
  events: curatorProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(200).default(""),
          page: z.number().int().min(0).max(10000).default(0),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const where = input.search
        ? {
            OR: [
              {
                name: { contains: input.search, mode: "insensitive" as const },
              },
              {
                curation: {
                  is: {
                    name: {
                      contains: input.search,
                      mode: "insensitive" as const,
                    },
                  },
                },
              },
            ],
          }
        : {};
      const [events, count] = await Promise.all([
        ctx.db.event.findMany({
          where,
          include: { curation: true },
          orderBy: [{ startsAt: "desc" }, { id: "asc" }],
          skip: input.page * 25,
          take: 25,
        }),
        ctx.db.event.count({ where }),
      ]);
      return { events, count };
    }),
  event: curatorProcedure
    .input(z.object({ id: z.string().min(1).max(100) }).strict())
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: input.id },
        include: {
          curation: true,
          rewardSources: {
            include: {
              rewards: {
                include: { curation: true },
                orderBy: { expectedAt: "asc" },
              },
            },
            orderBy: { name: "asc" },
          },
        },
      });
      if (!event)
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      return event;
    }),
  history: curatorProcedure
    .input(
      z
        .object({
          targetKind: z.enum(["EVENT", "REWARD"]),
          targetId: z.string().min(1).max(100),
          page: z.number().int().min(0).max(10000).default(0),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.curatorChange.findMany({
        where: { targetKind: input.targetKind, targetId: input.targetId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: input.page * 25,
        take: 25,
      }),
    ),
  save: curatorProcedure
    .input(curationChangeSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await saveCuration(ctx.db, ctx.session.user.id, input);
      try {
        revalidateTag("timeline-public-data");
        return { ...result, cacheInvalidated: true };
      } catch {
        console.warn(
          "A curator change was saved, but the timeline cache could not be invalidated.",
        );
        return { ...result, cacheInvalidated: false };
      }
    }),
});
