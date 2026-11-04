import { isImportTransactionConflict } from "./import-progress";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  bannerAnchorSourceFactsHash,
  bannerWindowFromEventStart,
} from "./banner-family-timing-reference";
import { effectiveEvent, eventIsHidden } from "./effective-schedule";
import {
  GLOBAL_SOURCE_LIMITS,
  BANNER_FAMILY_TIMING_LIMITS,
} from "~/shared/global-reconciliation-config";
import {
  lockSourceAuthority,
  requireSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";

const MAX_MEMBERS = BANNER_FAMILY_TIMING_LIMITS.maxMembersPerTransaction;
const include = {
  event: {
    include: { curation: true, globalBaseline: true, dateOverlay: true },
  },
  publications: {
    where: { ownedFields: { has: "TIMING" } },
    take: MAX_MEMBERS + 1,
    orderBy: { bannerId: "asc" },
    include: {
      identity: true,
      banner: {
        include: { dateOverlay: true, summonLineups: { select: { id: true } } },
      },
    },
  },
} satisfies Prisma.BannerFamilyTimingAnchorInclude;
type Anchor = Prisma.BannerFamilyTimingAnchorGetPayload<{
  include: typeof include;
}>;
export type BannerFamilyTimingReport = {
  status: "success" | "failed";
  examined: number;
  changed: number;
  unchanged: number;
  held: { bannerId: string; reason: string }[];
  failedBatch?: { familyIds: string[]; afterFamilyId: string | null };
};

function plan(anchors: Anchor[]) {
  const held: BannerFamilyTimingReport["held"] = [];
  const changes: {
    bannerId: string;
    revision: number;
    startsAt: Date;
    endsAt: Date | null;
    appliedAnchorStartsAt: Date;
    before: Prisma.InputJsonObject;
    after: Prisma.InputJsonObject;
  }[] = [];
  const followingBannerIds: string[] = [];
  let examined = 0,
    unchanged = 0;
  for (const anchor of anchors) {
    const event = anchor.event,
      effective = effectiveEvent(event);
    for (const owner of anchor.publications) {
      if (!owner.ownedFields.includes("TIMING")) continue;
      examined++;
      const banner = owner.banner;

      let reason: string | null = null;
      if (
        !owner.sourceStartsAt ||
        !owner.appliedAnchorStartsAt ||
        !anchor.referenceStartsAt ||
        !anchor.sourceFactsHash
      )
        reason = "REVIEWED_TIMING_REFERENCE_REQUIRED";
      else if (
        banner.familyId !== anchor.familyId ||
        event.familyId !== anchor.familyId
      )
        reason = "ANCHOR_MEMBERSHIP_CHANGED";
      else if (eventIsHidden(event) || banner.hidden) reason = "HIDDEN_MEMBER";
      else if (
        event.sourceRegion !== "JP" ||
        event.sourceStartsAtPrecision !== "EXACT" ||
        !event.sourceStartsAt ||
        bannerAnchorSourceFactsHash(event) !== anchor.sourceFactsHash
      )
        reason = "ANCHOR_SOURCE_CHANGED";
      else if (
        banner.status !== "PROJECTED" ||
        banner.sourceRegion !== "JP_PROJECTED" ||
        banner.dateOverlay
      )
        reason = "PROTECTED_BANNER_TIMING";
      else if (
        effective.startsAtPrecision !== "EXACT" ||
        banner.startsAtPrecision !== "EXACT" ||
        (banner.endsAt && banner.endsAtPrecision !== "EXACT")
      )
        reason = "EXACT_ANCHOR_REQUIRED";
      else if (banner.summonLineups.length)
        reason = "LINEUP_TIMING_REVIEW_REQUIRED";
      else if (
        !owner.ownedFields.includes("SOURCE") ||
        owner.timingAnchorRevision !== anchor.revision ||
        owner.identity.sourceKey !== owner.sourceKey ||
        banner.sourceUrl !== owner.identity.sourceUrl ||
        owner.identity.articleContentHash !== owner.articleContentHash ||
        owner.identity.periodEvidenceHash !== owner.periodEvidenceHash
      )
        reason = "REVIEWED_SOURCE_OR_OWNERSHIP_CHANGED";
      if (reason) {
        held.push({ bannerId: banner.id, reason: reason });
        continue;
      }
      const reference = {
        ...anchor,
        referenceStartsAt: anchor.referenceStartsAt!,
      };
      const source = {
        sourceStartsAt: owner.sourceStartsAt!,
        sourceEndsAt: owner.sourceEndsAt,
      };
      const last = bannerWindowFromEventStart(
        source,
        reference,
        event.sourceStartsAt!,
        owner.appliedAnchorStartsAt!,
      );
      const next = bannerWindowFromEventStart(
        source,
        reference,
        event.sourceStartsAt!,
        effective.startsAt,
      );
      if (!last || !next) {
        held.push({
          bannerId: banner.id,
          reason: "SOURCE_WINDOW_NOT_PROJECTABLE",
        });
        continue;
      }
      if (
        banner.startsAt.getTime() !== last.startsAt.getTime() ||
        (banner.endsAt?.getTime() ?? null) !== (last.endsAt?.getTime() ?? null)
      ) {
        held.push({ bannerId: banner.id, reason: "PUBLISHED_WINDOW_CHANGED" });
        continue;
      }
      followingBannerIds.push(banner.id);
      if (
        next.startsAt.getTime() === banner.startsAt.getTime() &&
        (next.endsAt?.getTime() ?? null) === (banner.endsAt?.getTime() ?? null)
      ) {
        unchanged++;
        continue;
      }
      changes.push({
        bannerId: banner.id,
        revision: owner.revision,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        appliedAnchorStartsAt: effective.startsAt,
        before: {
          startsAt: banner.startsAt.toISOString(),
          endsAt: banner.endsAt?.toISOString() ?? null,
          publicationRevision: owner.revision,
          appliedAnchorStartsAt: owner.appliedAnchorStartsAt!.toISOString(),
        },
        after: {
          startsAt: next.startsAt.toISOString(),
          endsAt: next.endsAt?.toISOString() ?? null,
          publicationRevision: owner.revision + 1,
          appliedAnchorStartsAt: effective.startsAt.toISOString(),
        },
      });
    }
  }
  if (examined > MAX_MEMBERS)
    throw new Error("Reviewed family timing exceeds its member limit.");
  return { examined, unchanged, held, changes, followingBannerIds };
}

async function load(
  tx: Prisma.TransactionClient,
  where: Prisma.BannerFamilyTimingAnchorWhereInput = {},
) {
  const rows = await tx.bannerFamilyTimingAnchor.findMany({
    where,
    orderBy: { familyId: "asc" },
    take: MAX_MEMBERS + 1,
    include,
  });
  if (
    rows.length > MAX_MEMBERS ||
    rows.reduce((sum, row) => sum + row.publications.length, 0) > MAX_MEMBERS
  )
    throw new Error("Reviewed family timing exceeds its scope limit.");
  return rows;
}

/** Caller holds the shared source lock. Locks and rereads before any derivation. */
async function rebaseSelectedFamilies(
  tx: Prisma.TransactionClient,
  actorId: string,
  where: Prisma.BannerFamilyTimingAnchorWhereInput,
) {
  const selected = await tx.bannerFamilyTimingAnchor.findMany({
    where,
    select: { familyId: true, anchorEventId: true },
    orderBy: { familyId: "asc" },
    take: MAX_MEMBERS + 1,
  });
  if (!selected.length)
    return {
      status: "success" as const,
      examined: 0,
      changed: 0,
      unchanged: 0,
      held: [],
      followingBannerIds: [],
    };
  if (selected.length > MAX_MEMBERS)
    throw new Error("Reviewed family timing exceeds its scope limit.");
  const familyIds = selected.map((row) => row.familyId),
    anchorIds = [...new Set(selected.map((row) => row.anchorEventId))].sort();
  await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(familyIds)}::jsonb)) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(anchorIds)}::jsonb)) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "familyId" IN (SELECT jsonb_array_elements_text(${JSON.stringify(familyIds)}::jsonb)) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "bannerId" FROM "BannerSourcePublication" WHERE "timingAnchorFamilyId" IN (SELECT jsonb_array_elements_text(${JSON.stringify(familyIds)}::jsonb)) ORDER BY "bannerId" FOR UPDATE`;
  const result = plan(await load(tx, { familyId: { in: familyIds } }));
  if (result.changes.length) {
    const payload = JSON.stringify(result.changes);
    const banners =
      await tx.$executeRaw`UPDATE "Banner" AS b SET "startsAt"=x."startsAt", "endsAt"=x."endsAt", "updatedAt"=CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${payload}::jsonb) AS x("bannerId" TEXT,"startsAt" TIMESTAMP,"endsAt" TIMESTAMP)
      WHERE b."id"=x."bannerId"`;
    const owners =
      await tx.$executeRaw`UPDATE "BannerSourcePublication" AS p SET "revision"=p."revision"+1, "appliedAnchorStartsAt"=x."appliedAnchorStartsAt", "updatedAt"=CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${payload}::jsonb) AS x("bannerId" TEXT,"revision" INT,"appliedAnchorStartsAt" TIMESTAMP)
      WHERE p."bannerId"=x."bannerId" AND p."revision"=x."revision"`;
    if (banners !== result.changes.length || owners !== result.changes.length)
      throw new Error("Reviewed family timing changed during publication.");
    await tx.curatorChange.createMany({
      data: result.changes.map((row) => ({
        actorId,
        targetKind: "BANNER",
        targetId: row.bannerId,
        action: "REBASE_JP_BANNER_FAMILY_TIMING",
        reason:
          "Follow the reviewed primary event using the original accepted pickup offsets.",
        before: row.before,
        after: row.after,
      })),
    });
  }
  return {
    status: "success" as const,
    examined: result.examined,
    changed: result.changes.length,
    unchanged: result.unchanged,
    held: result.held,
    followingBannerIds: result.followingBannerIds,
  };
}

/** Curator/official event moves retain their original atomic transaction. */
export async function rebaseBannerFamiliesInTransaction(
  tx: Prisma.TransactionClient,
  actorId: string,
  eventIds?: string[],
) {
  return rebaseSelectedFamilies(
    tx,
    actorId,
    eventIds ? { anchorEventId: { in: eventIds } } : {},
  );
}

/** Shared command/cron pass: keyset pages, bounded atomic batches and exact totals. */
export async function syncBannerFamilyTiming(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  dryRun: boolean,
): Promise<BannerFamilyTimingReport> {
  await requireSourceAuthority(database, authority);
  const active = { publications: { some: { ownedFields: { has: "TIMING" } } } };
  const [families, members, last] = await Promise.all([
    database.bannerFamilyTimingAnchor.count({ where: active }),
    database.bannerSourcePublication.count({
      where: {
        timingAnchorFamilyId: { not: null },
        ownedFields: { has: "TIMING" },
      },
    }),
    database.bannerFamilyTimingAnchor.findFirst({
      where: active,
      orderBy: { familyId: "desc" },
      select: { familyId: true },
    }),
  ]);
  if (
    families > BANNER_FAMILY_TIMING_LIMITS.maxFamiliesPerRun ||
    members > BANNER_FAMILY_TIMING_LIMITS.maxMembersPerRun
  )
    throw new Error("Reviewed family timing exceeds its run limit.");
  const report: BannerFamilyTimingReport = {
    status: "success",
    examined: 0,
    changed: 0,
    unchanged: 0,
    held: [],
  };
  if (!last) return report;
  let afterFamilyId: string | null = null;
  while (true) {
    let page: { familyId: string; _count: { publications: number } }[];
    try {
      page = await database.bannerFamilyTimingAnchor.findMany({
        where: {
          ...active,
          familyId: {
            ...(afterFamilyId ? { gt: afterFamilyId } : {}),
            lte: last.familyId,
          },
        },
        orderBy: { familyId: "asc" },
        take: BANNER_FAMILY_TIMING_LIMITS.familiesPerPage,
        select: {
          familyId: true,
          _count: {
            select: {
              publications: { where: { ownedFields: { has: "TIMING" } } },
            },
          },
        },
      });
    } catch (error) {
      if (!report.examined) throw error;
      return {
        ...report,
        status: "failed",
        failedBatch: { familyIds: [], afterFamilyId },
      };
    }
    if (!page.length) return report;
    const groups: string[][] = [];
    let group: string[] = [],
      size = 0;
    for (const row of page) {
      if (group.length && size + row._count.publications > MAX_MEMBERS) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(row.familyId);
      size += row._count.publications;
    }
    if (group.length) groups.push(group);
    for (const familyIds of groups) {
      try {
        const runBatch = () =>
          database.$transaction(
            async (tx) => {
              const where = { familyId: { in: familyIds } };
              if (dryRun) {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                const planned = plan(await load(tx, where));
                if (
                  report.examined + planned.examined >
                  BANNER_FAMILY_TIMING_LIMITS.maxMembersPerRun
                )
                  throw new Error(
                    "Reviewed family timing exceeds its run limit.",
                  );
                return {
                  examined: planned.examined,
                  changed: planned.changes.length,
                  unchanged: planned.unchanged,
                  held: planned.held,
                };
              }
              await lockSourceAuthority(tx, authority);
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
              const rebased = await rebaseSelectedFamilies(
                tx,
                authority.actorId,
                where,
              );
              if (
                report.examined + rebased.examined >
                BANNER_FAMILY_TIMING_LIMITS.maxMembersPerRun
              )
                throw new Error(
                  "Reviewed family timing exceeds its run limit.",
                );
              return rebased;
            },
            {
              isolationLevel: "RepeatableRead",
              maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
              timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
            },
          );
        let result: Awaited<ReturnType<typeof runBatch>> | undefined;
        for (let attempt = 1; ; attempt++) {
          try {
            result = await runBatch();
            break;
          } catch (error) {
            if (
              attempt >= GLOBAL_SOURCE_LIMITS.transactionAttempts ||
              !isImportTransactionConflict(error)
            )
              throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, GLOBAL_SOURCE_LIMITS.transactionRetryDelayMs),
            );
          }
        }
        report.examined += result.examined;
        report.changed += result.changed;
        report.unchanged += result.unchanged;
        report.held.push(...result.held);
        afterFamilyId = familyIds.at(-1)!;
      } catch (error) {
        if (!report.examined) throw error;
        // Earlier batches may have committed; keep their accounting on failure.
        return {
          ...report,
          status: "failed",
          failedBatch: { familyIds, afterFamilyId },
        };
      }
    }
  }
}
