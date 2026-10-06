import { z } from "zod";
import type { Prisma } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_ANNOUNCEMENT_MATCHING,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import { bannerFamilyStem } from "./banner-family-association";
import { normaliseAnnouncementName } from "./global-announcement-match";
import { publisherArticleUrl } from "./global-announcement-parser";
import { effectiveBanner } from "./effective-schedule";

const summon = z
  .object({
    kind: z.literal("SUMMON"),
    sourceRecordId: z.string(),
    articleName: z.string(),
    context: z.string(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    startTimezone: z.string().min(1),
    endTimezone: z.string().min(1),
    issues: z.array(z.string()).length(0),
  })
  .refine((period) => new Date(period.endsAt) >= new Date(period.startsAt));

export function matchesSummonBanner(
  period: { articleName: string; context: string; startsAt: string },
  banner: {
    name: string;
    startsAt: Date;
    projectedStartsAt: Date;
    featuredNames: string[];
  },
) {
  const stem = bannerFamilyStem(banner.name);
  const text = normaliseAnnouncementName(
    `${period.articleName} ${period.context}`,
  );
  if (!stem || !` ${text} `.includes(` ${stem} `)) return false;
  const start = new Date(period.startsAt).getTime();
  const windowDays = GLOBAL_ANNOUNCEMENT_MATCHING.windowDays.at(-1)!;
  if (
    ![banner.startsAt, banner.projectedStartsAt].some(
      (date) =>
        Math.abs(date.getTime() - start) <= windowDays * MILLISECONDS_PER_DAY,
    )
  )
    return false;
  return banner.featuredNames.some((name) => {
    const normalised = normaliseAnnouncementName(name);
    // Short names and pool-wide servant mentions cannot establish identity.
    return (
      normalised.length >=
        GLOBAL_ANNOUNCEMENT_MATCHING.minServantNameCharacters &&
      ` ${normaliseAnnouncementName(period.articleName)} `.includes(
        ` ${normalised} `,
      )
    );
  });
}

// The caller holds source authority and the Global source lock.
export async function publishOfficialBannerDates(
  tx: Prisma.TransactionClient,
  actorId: string,
  rows: Prisma.GlobalEventCandidateCreateManyInput[],
) {
  const sourceRows = rows.filter(
    (row) => summon.safeParse(row.snapshot).success,
  );
  if (!sourceRows.length) return { publishedCount: 0, publicationFailures: 0 };
  const candidates = await tx.globalEventCandidate.findMany({
    where: {
      sourceKind: "PUBLISHER_ANNOUNCEMENT",
      sourceRecordId: { in: sourceRows.map((row) => row.sourceRecordId) },
    },
    distinct: ["sourceRecordId"],
    orderBy: [
      { sourceRecordId: "asc" },
      { retrievedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  const banners = await tx.banner.findMany({
    relationLoadStrategy: "join",
    where: { familyId: { not: null } },
    include: {
      dateOverlay: { include: { candidate: true } },
      featured: { include: { servant: true } },
      family: {
        include: {
          events: {
            where: { type: "MAIN_EVENT" },
            select: {
              id: true,
              curation: { select: { active: true, hidden: true } },
            },
          },
        },
      },
    },
    orderBy: { id: "asc" },
    take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
  });
  if (
    [candidates, banners].some(
      (records) => records.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords,
    )
  )
    throw new Error("Banner publication exceeds the collection limit.");
  const proposals = candidates.flatMap((candidate) => {
    const row = sourceRows.find(
      (row) =>
        row.sourceRecordId === candidate.sourceRecordId &&
        row.contentHash === candidate.contentHash &&
        row.assessmentHash === candidate.assessmentHash,
    );
    const parsed = summon.safeParse(candidate.snapshot);
    if (
      !row ||
      !parsed.success ||
      publisherArticleUrl(candidate.sourceUrl) !== candidate.sourceUrl ||
      candidate.startsAt?.getTime() !==
        new Date(parsed.data.startsAt).getTime() ||
      candidate.endsAt?.getTime() !== new Date(parsed.data.endsAt).getTime()
    )
      return [];
    const period = parsed.data;
    const named = banners.filter((banner) =>
      matchesSummonBanner(period, {
        name: banner.name,
        startsAt: effectiveBanner(banner).startsAt,
        projectedStartsAt: banner.startsAt,
        featuredNames: banner.featured
          .filter((featured) => featured.servant.rarity === 5)
          .map((featured) => featured.servant.name),
      }),
    );
    let matches = named;
    for (const days of GLOBAL_ANNOUNCEMENT_MATCHING.windowDays) {
      matches = named.filter((banner) =>
        [effectiveBanner(banner).startsAt, banner.startsAt].some(
          (date) =>
            Math.abs(date.getTime() - candidate.startsAt!.getTime()) <=
            days * MILLISECONDS_PER_DAY,
        ),
      );
      if (matches.length) break;
    }
    if (matches.length !== 1 || matches[0]!.family!.events.length !== 1)
      return [];
    const anchor = matches[0]!.family!.events[0]!;
    if (anchor.curation?.active && anchor.curation.hidden) return [];
    return [{ banner: matches[0]!, candidate, period }];
  });
  const grouped = new Map<string, typeof proposals>();
  for (const proposal of proposals)
    grouped.set(proposal.banner.id, [
      ...(grouped.get(proposal.banner.id) ?? []),
      proposal,
    ]);
  let publicationFailures = 0;
  const changes = [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, group]) => {
      if (
        new Set(
          group.map(
            (proposal) =>
              `${proposal.period.startsAt}/${proposal.period.endsAt}`,
          ),
        ).size !== 1
      ) {
        publicationFailures++;
        return [];
      }
      const proposal = [...group].sort((a, b) =>
        a.candidate.sourceUrl.localeCompare(b.candidate.sourceUrl),
      )[0]!;
      const { banner, candidate } = proposal;
      const overlay = banner.dateOverlay;
      if (
        overlay?.startStatus === "OFFICIAL" &&
        overlay.endStatus === "OFFICIAL"
      ) {
        if (
          overlay.startsAt.getTime() === candidate.startsAt!.getTime() &&
          overlay.endsAt?.getTime() === candidate.endsAt!.getTime() &&
          overlay.candidate.sourceUrl === candidate.sourceUrl &&
          overlay.candidate.contentHash === candidate.contentHash
        )
          return [];
        if (overlay.candidate.sourceUrl !== candidate.sourceUrl) {
          publicationFailures++;
          return [];
        }
      } else if (banner.status === "OFFICIAL") return [];
      return [proposal];
    });
  if (!changes.length) return { publishedCount: 0, publicationFailures };
  const families = [
    ...new Set(changes.map((change) => change.banner.familyId!)),
  ].sort();
  await tx.$queryRaw`SELECT "id" FROM "EventFamily" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(families)}::jsonb)) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Banner" WHERE "id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(changes.map((change) => change.banner.id))}::jsonb)) ORDER BY "id" FOR UPDATE`;
  const overlays = changes.map(({ banner, candidate }) => ({
    bannerId: banner.id,
    anchorEventId: banner.family!.events[0]!.id,
    candidateId: candidate.id,
    startsAt: candidate.startsAt,
    endsAt: candidate.endsAt,
    sourceUrl: candidate.sourceUrl,
    retrievedAt: candidate.retrievedAt,
  }));
  await tx.$executeRaw`INSERT INTO "BannerDateOverlay" ("bannerId","anchorEventId","candidateId","startsAt","endsAt","startsAtPrecision","endsAtPrecision","startStatus","endStatus","sourceUrl","retrievedAt","updatedAt")
    SELECT x."bannerId",x."anchorEventId",x."candidateId",x."startsAt",x."endsAt",'EXACT'::"ScheduleTimePrecision",'EXACT'::"ScheduleTimePrecision",'OFFICIAL'::"ScheduleStatus",'OFFICIAL'::"ScheduleStatus",x."sourceUrl",x."retrievedAt",CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(overlays)}::jsonb) AS x("bannerId" TEXT,"anchorEventId" TEXT,"candidateId" TEXT,"startsAt" TIMESTAMP,"endsAt" TIMESTAMP,"sourceUrl" TEXT,"retrievedAt" TIMESTAMP)
    ON CONFLICT ("bannerId") DO UPDATE SET "anchorEventId"=EXCLUDED."anchorEventId","candidateId"=EXCLUDED."candidateId","startsAt"=EXCLUDED."startsAt","endsAt"=EXCLUDED."endsAt","startsAtPrecision"=EXCLUDED."startsAtPrecision","endsAtPrecision"=EXCLUDED."endsAtPrecision","startStatus"=EXCLUDED."startStatus","endStatus"=EXCLUDED."endStatus","sourceUrl"=EXCLUDED."sourceUrl","retrievedAt"=EXCLUDED."retrievedAt","updatedAt"=CURRENT_TIMESTAMP`;
  await tx.curatorChange.createMany({
    data: changes.map(({ banner, candidate }) => ({
      actorId,
      targetKind: "FAMILY",
      targetId: banner.familyId!,
      action: "PUBLISH_OFFICIAL_BANNER_DATES",
      reason: "Applied uniquely matched official summon announcement dates.",
      before: {
        bannerId: banner.id,
        startsAt: effectiveBanner(banner).startsAt.toISOString(),
        endsAt: effectiveBanner(banner).endsAt?.toISOString() ?? null,
      },
      after: {
        bannerId: banner.id,
        candidateId: candidate.id,
        sourceUrl: candidate.sourceUrl,
        startsAt: candidate.startsAt!.toISOString(),
        endsAt: candidate.endsAt!.toISOString(),
      },
    })),
  });
  return { publishedCount: changes.length, publicationFailures };
}
