import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import type { PrismaClient, Prisma } from "../../../generated/prisma";
import { requireCurator } from "~/server/auth/curator";

const issued = new WeakSet<object>();
const brand: unique symbol = Symbol("global-source-authority");
export type GlobalSourceAuthority = Readonly<{
  kind: "CURATOR" | "CRON" | "CLI";
  actorId: string;
  [brand]: true;
}>;

function issue(kind: GlobalSourceAuthority["kind"], actorId: string) {
  const authority = Object.freeze({ kind, actorId, [brand]: true as const });
  issued.add(authority);
  return authority;
}

export function curatorSourceAuthority(actorId: string) {
  return issue("CURATOR", actorId);
}

export function cliSourceAuthority() {
  const entry = process.argv[1];
  const expected = resolve(process.cwd(), "scripts/sync-event-schedule.mjs");
  if (!entry || resolve(entry) !== expected)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "CLI authority requires the local import command.",
    });
  return issue("CLI", "system:event-schedule-cli");
}

export function cronSourceAuthority(
  request: Request,
  secret: string | undefined,
) {
  if (!secret || secret.length < 16)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Cron authentication is not configured.",
    });
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorised." });
  return issue("CRON", "system:event-schedule-cron");
}

function verify(authority: GlobalSourceAuthority) {
  if (!issued.has(authority))
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid source-collection authority.",
    });
}

export async function requireSourceAuthority(
  database: PrismaClient | Prisma.TransactionClient,
  authority: GlobalSourceAuthority,
) {
  verify(authority);
  if (authority.kind === "CURATOR")
    await requireCurator(database, authority.actorId);
}

export async function lockSourceAuthority(
  tx: Prisma.TransactionClient,
  authority: GlobalSourceAuthority,
) {
  verify(authority);
  if (authority.kind === "CURATOR") {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${authority.actorId} FOR SHARE`;
    await requireCurator(tx, authority.actorId);
  }
}
