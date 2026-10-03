import { TRPCError } from "@trpc/server";

import type { PrismaClient, Prisma } from "../../../generated/prisma";

type AccessDatabase = Pick<PrismaClient | Prisma.TransactionClient, "user">;

export async function hasCuratorAccess(
  database: AccessDatabase,
  userId: string,
) {
  try {
    const user = await database.user.findUnique({
      where: { id: userId },
      select: { isCurator: true },
    });
    return user?.isCurator === true;
  } catch {
    throw new TRPCError({code: "INTERNAL_SERVER_ERROR", message: "Curator access could not be checked."});
  }
}

export async function requireCurator(
  database: AccessDatabase,
  userId: string | undefined,
) {
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (!(await hasCuratorAccess(database, userId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Curator access is required.",
    });
  }
}
