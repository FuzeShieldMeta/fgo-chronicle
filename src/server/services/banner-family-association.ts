import type { Prisma } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_ANNOUNCEMENT_MATCHING,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import { normaliseAnnouncementName } from "./global-announcement-match";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import { effectiveEvent } from "./effective-schedule";
import {
  publicEventDateOverlaySelect,
  publicEventGlobalBaselineSelect,
  publicDateEvidenceSelect,
} from "./global-baseline-select";
import {
  BANNER_EVENT_IDENTITIES,
  BANNER_FAMILY_MATCHING,
} from "~/shared/banner-event-identities";

export function normaliseBannerTitle(name: string) {
  const title = normaliseAnnouncementName(
    name.replace(/\s*\((?:EN|JP)\)\s*$/i, ""),
  );
  const rerun = /\b(?:rerun|revival)\b/u.test(title);
  const base = title
    .replace(/\b(?:rerun|revival)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return `${rerun ? "revival " : ""}${base}`;
}

export function containsBannerTitle(title: string, context: string) {
  const normalName = normaliseBannerTitle(title);
  const normalText = normaliseBannerTitle(context);
  if (/^revival\b/u.test(normalName) !== /^revival\b/u.test(normalText))
    return false;
  const name = normalName.replace(/^revival\s/u, "");
  const text = normalText.replace(/^revival\s/u, "");
  const offset = ` ${text} `.indexOf(` ${name} `);
  if (offset < 0) return false;
  const following = ` ${text} `.slice(offset + name.length + 2).trim();
  return !/^(?:\d+|[ivx]+)(?:\s|$)|^(?:part|chapter|act|episode)\s+(?:\d+|[ivx]+)(?:\s|$)/u.test(
    following,
  );
}

export function bannerFamilyStem(name: string) {
  const stem = normaliseBannerTitle(name)
    .replace(
      /\s+(?:fp\s+)?(?:banner|pickup summon|summoning campaign)(?:\s+\d+)?$/,
      "",
    )
    .replace(/\b(campaign)\s+\d+$/u, "$1");
  return stem.length >= GLOBAL_ANNOUNCEMENT_MATCHING.minNameCharacters &&
    stem.split(" ").length >= GLOBAL_ANNOUNCEMENT_MATCHING.minNameTokens
    ? stem
    : null;
}

const explicitBannerEvents = new Map<string, Set<string>>();
for (const [sourceKey, names] of Object.entries(BANNER_EVENT_IDENTITIES)) {
  for (const name of names) {
    const stem = bannerFamilyStem(name);
    if (!stem)
      throw new Error("A configured banner identity has no usable title.");
    const targets = explicitBannerEvents.get(stem) ?? new Set<string>();
    targets.add(sourceKey);
    explicitBannerEvents.set(stem, targets);
  }
}

export function matchesBannerFamily(
  banner: { name: string; startsAt: Date },
  event: {
    names: string[];
    startsAt: Date;
    endsAt: Date | null;
    sourceKey?: string;
    effectiveStartsAt?: Date;
    effectiveEndsAt?: Date | null;
  },
) {
  const stem = bannerFamilyStem(banner.name);
  if (!stem || !event.endsAt) return false;
  const day = (date: Date) => Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
  const targets = explicitBannerEvents.get(stem);
  const explicit = targets?.has(event.sourceKey ?? "") ?? false;
  if (targets && !explicit) return false;
  const ranges = [
    [event.startsAt, event.endsAt],
    [event.effectiveStartsAt, event.effectiveEndsAt],
  ] as const;
  return (
    ranges.some(
      ([start, end]) =>
        start &&
        end &&
        day(banner.startsAt) >=
          day(start) -
            (explicit ? BANNER_FAMILY_MATCHING.explicitIdentityLeadDays : 0) &&
        day(banner.startsAt) <= day(end),
    ) &&
    (explicit ||
      event.names.some(
        (name) =>
          /\bpre release\b/u.test(normaliseBannerTitle(name)) ===
            /\bpre release\b/u.test(stem) && containsBannerTitle(stem, name),
      ))
  );
}

export async function loadBannerFamilyEvents(tx: Prisma.TransactionClient) {
  const events = await tx.event.findMany({
    relationLoadStrategy: "join",
    where: {
      type: {
        in: ["MAIN_EVENT", "CAMPAIGN", "PRE_RELEASE_CAMPAIGN", "QUEST_RELEASE"],
      },
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
      curation: true,
      startsAtPrecision: true,
      endsAtPrecision: true,
      status: true,
      updatedAt: true,
      dateOverlay: publicEventDateOverlaySelect,
      globalBaseline: publicEventGlobalBaselineSelect,
      dateEvidence: publicDateEvidenceSelect,
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
    [events, aliases].some(
      (rows) => rows.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords,
    )
  )
    throw new Error("Banner family association exceeds the collection limit.");
  return events
    .filter((event) => !(event.curation?.active && event.curation.hidden))
    .map((event) => {
      const assessment = aliases.find(
        (alias) => alias.targetEventId === event.id,
      );
      const alias = assessment ? verifiedAtlasAlias(assessment, event) : null;
      const effective = effectiveEvent(event);
      return {
        ...event,
        names: [
          event.name,
          ...(event.curation?.active ? [event.curation.name] : []),
          ...(alias ? [alias] : []),
        ],
        effectiveStartsAt: effective.startsAt,
        effectiveEndsAt: effective.endsAt,
      };
    });
}

export function assessBannerFamily(
  banner: { name: string; startsAt: Date },
  events: Awaited<ReturnType<typeof loadBannerFamilyEvents>>,
) {
  const matches = events.filter((event) => matchesBannerFamily(banner, event));
  const families = [...new Set(matches.map((event) => event.familyId!))];
  return {
    familyId: families.length === 1 ? families[0]! : null,
    candidateFamilyIds: families,
  };
}

// The caller holds the Global source lock and rechecks collection authority.
export async function associateBannerFamilies(
  tx: Prisma.TransactionClient,
  actorId: string,
) {
  const banners = await tx.banner.findMany({
    where: {
      familyId: null,
      sourceRegion: { in: ["JP_PROJECTED", "NA"] },
      status: { in: ["PROJECTED", "OFFICIAL"] },
    },
    select: { id: true, name: true, startsAt: true },
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  if (banners.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords)
    throw new Error("Banner family association exceeds the collection limit.");
  if (!banners.length) return 0;
  const events = await loadBannerFamilyEvents(tx);
  const links = banners.flatMap((banner) => {
    const match = assessBannerFamily(banner, events);
    return match.familyId
      ? [{ bannerId: banner.id, familyId: match.familyId }]
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
