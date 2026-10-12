import type { Prisma } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_ANNOUNCEMENT_MATCHING,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import { normaliseAnnouncementName } from "./global-announcement-match";
import { verifiedAtlasAlias } from "./global-announcement-alias";

export function bannerFamilyStem(name: string) {
  const stem = normaliseAnnouncementName(name).replace(
    /\s+(?:fp\s+)?banner(?:\s+\d+)?$/,
    "",
  );
  return stem.length >= GLOBAL_ANNOUNCEMENT_MATCHING.minNameCharacters &&
    stem.split(" ").length >= GLOBAL_ANNOUNCEMENT_MATCHING.minNameTokens
    ? stem
    : null;
}

export function matchesBannerFamily(
  banner: { name: string; startsAt: Date },
  event: { names: string[]; startsAt: Date; endsAt: Date | null },
) {
  const stem = bannerFamilyStem(banner.name);
  if (!stem || !event.endsAt) return false;
  const day = (date: Date) => Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
  return (
    day(banner.startsAt) >= day(event.startsAt) &&
    day(banner.startsAt) <= day(event.endsAt) &&
    event.names.some((name) => {
      const text = normaliseAnnouncementName(name);
      return text === stem || text.startsWith(`${stem} `);
    })
  );
}

// The caller holds the Global source lock and rechecks collection authority.
export async function associateBannerFamilies(
  tx: Prisma.TransactionClient,
  actorId: string,
) {
  const banners = await tx.banner.findMany({
    where: {
      familyId: null,
      sourceRegion: "JP_PROJECTED",
      status: "PROJECTED",
    },
    select: { id: true, name: true, startsAt: true },
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  if (!banners.length) return 0;
  const events = await tx.event.findMany({
    relationLoadStrategy: "join",
    where: {
      type: { in: ["MAIN_EVENT", "CAMPAIGN", "PRE_RELEASE_CAMPAIGN"] },
      sourceRegion: "JP",
      familyId: { not: null },
    },
    select: {
      id: true,
      sourceKey: true,
      sourceRegion: true,
      familyId: true,
      name: true,
      startsAt: true,
      endsAt: true,
      curation: { select: { active: true, hidden: true, name: true } },
    },
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  const aliases = await tx.globalEventCandidate.findMany({
    where: { sourceKind: "GLOBAL_GAME_DATA" },
    distinct: ["sourceRecordId"],
    orderBy: [
      { sourceRecordId: "asc" },
      { retrievedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  if (
    [banners, events, aliases].some(
      (rows) => rows.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords,
    )
  )
    throw new Error("Banner family association exceeds the collection limit.");
  const links = banners.flatMap((banner) => {
    const matches = events.filter((event) => {
      if (event.curation?.active && event.curation.hidden) return false;
      const assessment = aliases.find(
        (alias) => alias.targetEventId === event.id,
      );
      const alias = assessment ? verifiedAtlasAlias(assessment, event) : null;
      return matchesBannerFamily(banner, {
        ...event,
        names: [
          event.name,
          ...(event.curation?.active ? [event.curation.name] : []),
          ...(alias ? [alias] : []),
        ],
      });
    });
    return matches.length === 1
      ? [{ bannerId: banner.id, familyId: matches[0]!.familyId! }]
      : [];
  });
  if (!links.length) return 0;
  const families = [...new Set(links.map((link) => link.familyId))].sort();
  await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(families)}::jsonb)) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(links.map((link) => link.bannerId))}::jsonb)) ORDER BY "id" FOR UPDATE`;
  const count =
    await tx.$executeRaw`UPDATE "Banner" b SET "familyId"=x."familyId", "updatedAt"=CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb) AS x("bannerId" TEXT,"familyId" TEXT)
    WHERE b."id"=x."bannerId" AND b."familyId" IS NULL`;
  if (count)
    await tx.curatorChange.create({
      data: {
        actorId,
        targetKind: "FAMILY",
        targetId: "banner-family-associations",
        action: "LINK_BANNER_FAMILIES",
        reason:
          "Associated unlinked projected banners with unique source event families.",
        before: { unlinked: links.map((link) => link.bannerId) },
        after: { links },
      },
    });
  return count;
}
