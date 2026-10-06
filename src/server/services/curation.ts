import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { PrismaClient, Prisma } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import { effectiveEvent } from "./effective-schedule";
import {
  eventCurationFields,
  rewardCurationFields,
} from "./curation-ownership";

const precision = z.enum(["DATE_ONLY", "EXACT"]);
export const eventCurationSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    startsAt: z.date(),
    startsAtPrecision: precision,
    endsAt: z.date().nullable(),
    endsAtPrecision: precision.nullable(),
    hidden: z.boolean(),
    shiftRewardDates: z.boolean(),
    ownedFields: z
      .array(z.enum(eventCurationFields))
      .max(eventCurationFields.length)
      .refine((fields) => new Set(fields).size === fields.length)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endsAt && value.endsAt < value.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end must not precede the start.",
      });
    }
    if (Boolean(value.endsAt) !== Boolean(value.endsAtPrecision)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAtPrecision"],
        message: "Set an end precision only when an end date exists.",
      });
    }
  });
export const rewardCurationSchema = z
  .object({
    itemType: z.enum([
      "SAINT_QUARTZ",
      "SAINT_QUARTZ_FRAGMENT",
      "SUMMON_TICKET",
      "CRYSTALLIZED_LORE",
      "HOLY_GRAIL",
    ]),
    amount: z.number().int().min(0).max(2_147_483_647),
    expectedAt: z.date().nullable(),
    nature: z.enum(["DETERMINISTIC", "CONDITIONAL", "CURATED_ESTIMATE"]),
    eligibility: z.string().trim().max(4000).nullable(),
    defaultIncluded: z.boolean(),
    ownedFields: z
      .array(z.enum(rewardCurationFields))
      .max(rewardCurationFields.length)
      .refine((fields) => new Set(fields).size === fields.length)
      .optional(),
  })
  .strict();
export const curationChangeSchema = z
  .object({
    targetKind: z.enum(["EVENT", "REWARD"]),
    targetId: z.string().trim().min(1).max(100),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(3).max(1000),
    values: z.union([eventCurationSchema, rewardCurationSchema]).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.values &&
      !(
        value.targetKind === "EVENT"
          ? eventCurationSchema
          : rewardCurationSchema
      ).safeParse(value.values).success
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["values"],
        message: "The correction does not match the selected record.",
      });
    }
  });

function snapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function saveCuration(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
) {
  const input = curationChangeSchema.parse(rawInput);
  return database.$transaction(
    async (tx) => {
      // Revocation waits for edits already authorised in this transaction.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      await requireCurator(tx, actorId);
      const eventTarget = input.targetKind === "EVENT";
      if (eventTarget) {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${input.targetId} FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT "id" FROM "RewardDefinition" WHERE "id" = ${input.targetId} FOR UPDATE`;
      }
      const source = eventTarget
        ? await tx.event.findUnique({
            where: { id: input.targetId },
            include: {
              curation: true,
              globalBaseline: true,
              dateOverlay: true,
              dateEvidence: true,
            },
          })
        : await tx.rewardDefinition.findUnique({
            where: { id: input.targetId },
            include: { curation: true },
          });
      if (!source)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The source record no longer exists.",
        });
      const previous = source.curation;
      if ((previous?.revision ?? 0) !== input.expectedRevision) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Another curator changed this record. Reload it before saving.",
        });
      }
      if (!input.values && !previous?.active) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This record already uses imported values.",
        });
      }
      const revision = input.expectedRevision + 1;
      let next;
      if (eventTarget) {
        const values = input.values
          ? eventCurationSchema.parse(input.values)
          : null;
        const ownedFields = values?.ownedFields ??
          (previous?.active ? previous.ownedFields : undefined) ?? [
            ...eventCurationFields,
          ];
        if (values && "startsAt" in source) {
          const baseline = effectiveEvent({ ...source, curation: null });
          const start = ownedFields.includes("startsAt")
            ? values.startsAt
            : baseline.startsAt;
          const end = ownedFields.includes("endsAt")
            ? values.endsAt
            : baseline.endsAt;
          if (end && end < start)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "The displayed end must not precede the displayed start.",
            });
        }
        next = input.values
          ? await tx.eventCuration.upsert({
              where: { eventId: input.targetId },
              create: {
                eventId: input.targetId,
                revision,
                active: ownedFields.length > 0,
                ...eventCurationSchema.parse(input.values),
                ownedFields,
              },
              update: {
                revision,
                active: ownedFields.length > 0,
                ...eventCurationSchema.parse(input.values),
                ownedFields,
              },
            })
          : await tx.eventCuration.update({
              where: { eventId: input.targetId },
              data: { active: false, revision },
            });
      } else {
        const values = input.values
          ? rewardCurationSchema.parse(input.values)
          : null;
        const ownedFields = values?.ownedFields ??
          (previous?.active ? previous.ownedFields : undefined) ?? [
            ...rewardCurationFields,
          ];
        next = input.values
          ? await tx.rewardCuration.upsert({
              where: { rewardId: input.targetId },
              create: {
                rewardId: input.targetId,
                revision,
                active: ownedFields.length > 0,
                ...rewardCurationSchema.parse(input.values),
                ownedFields,
              },
              update: {
                revision,
                active: ownedFields.length > 0,
                ...rewardCurationSchema.parse(input.values),
                ownedFields,
              },
            })
          : await tx.rewardCuration.update({
              where: { rewardId: input.targetId },
              data: { active: false, revision },
            });
      }
      const imported = { ...source, curation: undefined };
      await tx.curatorChange.create({
        data: {
          actorId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          action: input.values ? "SAVE" : "RESET",
          reason: input.reason,
          before: snapshot({ source: imported, curation: previous }),
          after: snapshot({ curation: next }),
        },
      });
      return { revision };
    },
    { maxWait: 5000, timeout: 10000 },
  );
}
