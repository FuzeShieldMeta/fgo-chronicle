import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";

export const curatorBannerPageSize = 25;
export const curatorBannerListSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    page: z.number().int().min(0).max(10000).default(0),
    visibility: z.enum(["ALL", "VISIBLE", "HIDDEN"]).default("ALL"),
  })
  .strict();
export const bannerVisibilitySchema = z
  .object({
    bannerId: z.string().trim().min(1).max(100),
    hidden: z.boolean(),
    expectedUpdatedAt: z.date(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export async function saveBannerVisibility(
  database: PrismaClient,
  actorId: string,
  rawInput: unknown,
) {
  const input = bannerVisibilitySchema.parse(rawInput);
  return database.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actorId} FOR SHARE`;
      await requireCurator(tx, actorId);
      await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "id"=${input.bannerId} FOR UPDATE`;
      const banner = await tx.banner.findUnique({
        where: { id: input.bannerId },
      });
      if (!banner)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Banner not found.",
        });
      if (banner.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
        throw new TRPCError({
          code: "CONFLICT",
          message: "This banner changed. Reload it before saving.",
        });
      if (banner.hidden === input.hidden) return { changed: false, banner };
      const saved = await tx.banner.update({
        where: { id: banner.id },
        data: { hidden: input.hidden },
      });
      await tx.curatorChange.create({
        data: {
          actorId,
          targetKind: "BANNER",
          targetId: banner.id,
          action: input.hidden ? "HIDE" : "RESTORE",
          reason: input.reason,
          before: { hidden: banner.hidden },
          after: { hidden: saved.hidden },
        },
      });
      return { changed: true, banner: saved };
    },
    { maxWait: 10000, timeout: 15000 },
  );
}
