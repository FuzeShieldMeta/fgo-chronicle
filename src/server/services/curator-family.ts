import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";
import { effectiveFamily } from "./effective-schedule";

export const curatorFamilyInclude = {
  curation: true,
  events: { select: { id: true }, orderBy: { id: "asc" } },
  banners: { select: { id: true }, orderBy: { id: "asc" } },
} satisfies Prisma.EventFamilyInclude;
export type CuratorFamily = Prisma.EventFamilyGetPayload<{
  include: typeof curatorFamilyInclude;
}>;

export const familyNameInputSchema = z
  .object({
    familyId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(300).nullable(),
  })
  .strict();
export const publishFamilyNameSchema = familyNameInputSchema
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export function previewFamilyName(family: CuratorFamily, name: string | null) {
  const preview = {
    familyId: family.id,
    sourceName: family.name,
    currentName: effectiveFamily(family).name,
    nextName: name ?? family.name,
    revision: family.curation?.revision ?? 0,
    active: family.curation?.active ?? false,
    reset: name === null,
    eventIds: family.events.map((event) => event.id).sort(),
    bannerIds: family.banners.map((banner) => banner.id).sort(),
  };
  return {
    ...preview,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(preview))
      .digest("hex"),
  };
}

export async function publishFamilyName(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
) {
  const input = publishFamilyNameSchema.parse(rawInput);
  return database.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      await requireCurator(tx, actorId);
      await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" = ${input.familyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "familyId" = ${input.familyId} ORDER BY "id" FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "familyId" = ${input.familyId} ORDER BY "id" FOR SHARE`;
      const family = await tx.eventFamily.findUnique({
        where: { id: input.familyId },
        include: curatorFamilyInclude,
      });
      if (!family)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Family not found.",
        });
      const preview = previewFamilyName(family, input.name);
      if (input.fingerprint !== preview.fingerprint)
        throw new TRPCError({
          code: "CONFLICT",
          message: "The family changed. Preview it again before saving.",
        });
      if (input.name === null && !family.curation?.active)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This family already uses its imported name.",
        });
      const revision = preview.revision + 1;
      const next =
        input.name === null
          ? await tx.eventFamilyCuration.update({
              where: { familyId: family.id },
              data: { active: false, revision },
            })
          : await tx.eventFamilyCuration.upsert({
              where: { familyId: family.id },
              create: {
                familyId: family.id,
                name: input.name,
                active: true,
                revision,
              },
              update: { name: input.name, active: true, revision },
            });
      await tx.curatorChange.create({
        data: {
          actorId,
          targetKind: "FAMILY",
          targetId: family.id,
          action: input.name === null ? "RESET" : "SAVE",
          reason: input.reason,
          before: {
            sourceName: family.name,
            effectiveName: preview.currentName,
            revision: preview.revision,
          },
          after: {
            name: preview.nextName,
            revision,
            active: next.active,
            eventIds: preview.eventIds,
            bannerIds: preview.bannerIds,
          },
        },
      });
      return { revision };
    },
    { maxWait: 5000, timeout: 10000 },
  );
}
