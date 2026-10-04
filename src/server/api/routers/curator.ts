import { z } from "zod";
import { revalidateTag } from "next/cache";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, curatorProcedure } from "~/server/api/trpc";
import { curationChangeSchema, saveCuration } from "~/server/services/curation";
import {
  curatorFamilyInclude,
  familyNameInputSchema,
  previewFamilyName,
  publishFamilyName,
  publishFamilyNameSchema,
} from "~/server/services/curator-family";
import {
  describeEventReview,
  reviewEventInclude,
  reviewInputSchema,
  saveReview,
} from "~/server/services/curator-review";
import {
  buildCuratorQueue,
  curatorQueueSchema,
} from "~/server/services/curator-queue";

export const curatorRouter = createTRPCRouter({
  dateEvidence: curatorProcedure
    .input(
      z
        .object({
          eventId: z.string().min(1).max(100),
          page: z.number().int().min(0).max(10000).default(0),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.eventDateEvidence.findMany({
        where: { eventId: input.eventId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: input.page * 25,
        take: 25,
      }),
    ),
  family: curatorProcedure
    .input(z.object({ id: z.string().min(1).max(100) }).strict())
    .query(async ({ ctx, input }) => {
      const family = await ctx.db.eventFamily.findUnique({
        where: { id: input.id },
        include: curatorFamilyInclude,
      });
      if (!family)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Family not found.",
        });
      return family;
    }),
  previewFamilyName: curatorProcedure
    .input(familyNameInputSchema)
    .query(async ({ ctx, input }) => {
      const family = await ctx.db.eventFamily.findUnique({
        where: { id: input.familyId },
        include: curatorFamilyInclude,
      });
      if (!family)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Family not found.",
        });
      return previewFamilyName(family, input.name);
    }),
  publishFamilyName: curatorProcedure
    .input(publishFamilyNameSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await publishFamilyName(
        ctx.db,
        ctx.session.user.id,
        input,
      );
      try {
        revalidateTag("timeline-public-data");
        return { ...result, cacheInvalidated: true };
      } catch {
        console.warn(
          "A family name was saved, but the timeline cache could not refresh.",
        );
        return { ...result, cacheInvalidated: false };
      }
    }),
  events: curatorProcedure
    .input(curatorQueueSchema)
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
      const events = await ctx.db.event.findMany({
        relationLoadStrategy: "join",
        where,
        include: reviewEventInclude,
      });
      return buildCuratorQueue(events, input);
    }),
  event: curatorProcedure
    .input(z.object({ id: z.string().min(1).max(100) }).strict())
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        relationLoadStrategy: "join",
        where: { id: input.id },
        include: reviewEventInclude,
      });
      if (!event)
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      return describeEventReview(event);
    }),
  review: curatorProcedure
    .input(reviewInputSchema)
    .mutation(({ ctx, input }) =>
      saveReview(ctx.db, ctx.session.user.id, input),
    ),
  history: curatorProcedure
    .input(
      z
        .object({
          targetKind: z.enum(["EVENT", "REWARD", "FAMILY"]),
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
