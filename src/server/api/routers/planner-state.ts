import { Prisma } from "../../../../generated/prisma/index.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { plannerStatePayloadSchema } from "~/app/timeline/_lib/planner-state";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

function parseStoredPayload(value: Prisma.JsonValue) {
  const result = plannerStatePayloadSchema.safeParse(value);
  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Cloud planner data could not be loaded.",
    });
  }
  return result.data;
}

const savedPlannerState = {
  payload: true,
  revision: true,
  updatedAt: true,
} satisfies Prisma.PlannerStateSelect;

export const plannerStateRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx }) => {
    const state = await ctx.db.plannerState.findUnique({
      where: { userId: ctx.session.user.id },
      select: savedPlannerState,
    });
    if (!state) return null;
    return {
      payload: parseStoredPayload(state.payload),
      revision: state.revision,
      updatedAt: state.updatedAt,
    };
  }),

  save: protectedProcedure
    .input(
      z.object({
        payload: plannerStatePayloadSchema,
        expectedRevision: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const payload = input.payload as Prisma.InputJsonValue;

      if (input.expectedRevision === null) {
        try {
          const created = await ctx.db.plannerState.create({
            data: { userId, payload },
            select: savedPlannerState,
          });
          return {
            payload: parseStoredPayload(created.payload),
            revision: created.revision,
            updatedAt: created.updatedAt,
          };
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            throw new TRPCError({ code: "CONFLICT" });
          }
          throw error;
        }
      }

      const updated = await ctx.db.plannerState.updateManyAndReturn({
        where: { userId, revision: input.expectedRevision },
        data: { payload, revision: { increment: 1 } },
        select: savedPlannerState,
      });
      const state = updated[0];
      if (!state) throw new TRPCError({ code: "CONFLICT" });
      return {
        payload: parseStoredPayload(state.payload),
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
    }),
});
