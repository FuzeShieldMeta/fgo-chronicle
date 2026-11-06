import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import {
  bannerDatasetSchema,
  bannerSourceKey,
  bannerPublicationTiming,
} from "./banner-dataset";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";

export async function importBannerDataset(
  database: PrismaClient,
  input: unknown,
  authorize?: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const { banners } = bannerDatasetSchema.parse(input);
  const servants = [
    ...new Map(
      banners
        .flatMap((banner) => banner.servants)
        .map((servant) => [
          servant.id,
          {
            id: servant.id,
            name: servant.name,
            className: servant.class,
            rarity: servant.rarity ?? null,
            faceId: servant.faceId ?? null,
          },
        ]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
  const records = banners
    .map((banner) => ({
      id: randomUUID(),
      sourceKey: bannerSourceKey(banner),
      name: banner.name,
      ...bannerPublicationTiming(banner),
      status: banner.status === "CONFIRMED_EN" ? "OFFICIAL" : banner.status,
      sourceRegion: banner.sourceSchedule === "NA" ? "NA" : "JP_PROJECTED",
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return database.$transaction(
    async (tx) => {
      if (authorize) await authorize(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      const identities = await tx.bannerSourceIdentity.findMany({
        where: { sourceKey: { in: records.map((record) => record.sourceKey) } },
        select: { banner: { select: { sourceKey: true } }, sourceKey: true },
      });
      if (
        identities.some(
          (identity) => identity.sourceKey !== identity.banner.sourceKey,
        )
      )
        throw new Error(
          "Banner source key is already bound to a different legacy banner.",
        );
      const ownedBanners = await tx.banner.findMany({
        where: {
          sourceKey: { in: records.map((record) => record.sourceKey) },
          sourcePublication: { isNot: null },
        },
        select: {
          sourceKey: true,
          name: true,
          sourceUrl: true,
          status: true,
          sourceRegion: true,
          startsAt: true,
          endsAt: true,
          startsAtPrecision: true,
          endsAtPrecision: true,
          sourcePublication: { select: { ownedFields: true } },
        },
      });
      const owners = new Map(
        ownedBanners.map((banner) => [banner.sourceKey, banner]),
      );
      const sourceRecords = records.map((record) => {
        const owner = owners.get(record.sourceKey);
        const fields = owner?.sourcePublication?.ownedFields ?? [];
        return {
          ...record,
          ...(owner && fields.includes("NAME") ? { name: owner.name } : {}),
          ...(owner && fields.includes("SOURCE")
            ? {
                sourceUrl: owner.sourceUrl,
                status: owner.status,
                sourceRegion: owner.sourceRegion,
              }
            : {}),
          ...(owner && fields.includes("TIMING")
            ? {
                startsAt: owner.startsAt,
                endsAt: owner.endsAt,
                startsAtPrecision: owner.startsAtPrecision,
                endsAtPrecision: owner.endsAtPrecision,
              }
            : {}),
        };
      });
      // NA availability is resolved only by catalogue sync; false is also catalogue-backed.
      const metadataOwners = await tx.servant.findMany({
        where: {
          id: { in: servants.map((servant) => servant.id) },
          OR: [
            { atlasNaAvailable: { not: null } },
            {
              banners: {
                some: {
                  banner: {
                    sourcePublication: { ownedFields: { has: "ROSTER" } },
                  },
                },
              },
            },
          ],
        },
        select: { id: true },
      });
      const ownedMemberIds = new Set(
        metadataOwners.map((servant) => servant.id),
      );
      const sourceServants = servants.filter(
        (servant) => !ownedMemberIds.has(servant.id),
      );
      await tx.$executeRaw`INSERT INTO "Servant" ("id","name","className","rarity","faceId")
      SELECT x."id",x."name",x."className",x."rarity",x."faceId"
      FROM jsonb_to_recordset(${JSON.stringify(sourceServants)}::jsonb) AS x("id" INT,"name" TEXT,"className" TEXT,"rarity" INT,"faceId" INT)
      ORDER BY x."id"
      ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name","className"=EXCLUDED."className","rarity"=EXCLUDED."rarity","faceId"=COALESCE(EXCLUDED."faceId","Servant"."faceId")
      WHERE "Servant"."atlasNaAvailable" IS NULL
        AND ("Servant"."name","Servant"."className","Servant"."rarity","Servant"."faceId") IS DISTINCT FROM (EXCLUDED."name",EXCLUDED."className",EXCLUDED."rarity",COALESCE(EXCLUDED."faceId","Servant"."faceId"))`;
      const changedBanners =
        await tx.$executeRaw`INSERT INTO "Banner" ("id","sourceKey","name","startsAt","endsAt","startsAtPrecision","endsAtPrecision","status","sourceRegion","sourceUrl","updatedAt")
      SELECT x."id",x."sourceKey",x."name",x."startsAt",x."endsAt",x."startsAtPrecision"::"ScheduleTimePrecision",x."endsAtPrecision"::"ScheduleTimePrecision",x."status"::"ScheduleStatus",x."sourceRegion",x."sourceUrl",CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(sourceRecords)}::jsonb) AS x("id" TEXT,"sourceKey" TEXT,"name" TEXT,"startsAt" TIMESTAMP,"endsAt" TIMESTAMP,"startsAtPrecision" TEXT,"endsAtPrecision" TEXT,"status" TEXT,"sourceRegion" TEXT,"sourceUrl" TEXT)
      ORDER BY x."sourceKey"
      ON CONFLICT ("sourceKey") DO UPDATE SET "name"=EXCLUDED."name","startsAt"=EXCLUDED."startsAt","endsAt"=EXCLUDED."endsAt","startsAtPrecision"=EXCLUDED."startsAtPrecision","endsAtPrecision"=EXCLUDED."endsAtPrecision","status"=EXCLUDED."status","sourceRegion"=EXCLUDED."sourceRegion","sourceUrl"=COALESCE(EXCLUDED."sourceUrl","Banner"."sourceUrl"),"updatedAt"=CURRENT_TIMESTAMP
      WHERE ("Banner"."name","Banner"."startsAt","Banner"."endsAt","Banner"."startsAtPrecision","Banner"."endsAtPrecision","Banner"."status","Banner"."sourceRegion","Banner"."sourceUrl") IS DISTINCT FROM (EXCLUDED."name",EXCLUDED."startsAt",EXCLUDED."endsAt",EXCLUDED."startsAtPrecision",EXCLUDED."endsAtPrecision",EXCLUDED."status",EXCLUDED."sourceRegion",COALESCE(EXCLUDED."sourceUrl","Banner"."sourceUrl"))`;
      const saved = await tx.banner.findMany({
        where: { sourceKey: { in: records.map((record) => record.sourceKey) } },
        select: {
          id: true,
          sourceKey: true,
          featured: { select: { servantId: true, soloRateUp: true } },
          summonLineups: { include: { featured: true } },
        },
      });
      const keyToBanner = new Map(
        saved.map((banner) => [banner.sourceKey, banner]),
      );
      const signature = (
        featured: { servantId: number; soloRateUp: boolean }[],
      ) =>
        JSON.stringify([...featured].sort((a, b) => a.servantId - b.servantId));
      const changes = banners.flatMap((banner) => {
        if (
          owners
            .get(bannerSourceKey(banner))
            ?.sourcePublication?.ownedFields.includes("ROSTER")
        )
          return [];
        const savedBanner = keyToBanner.get(bannerSourceKey(banner))!;
        const featured = banner.servants.map((servant) => ({
          servantId: servant.id,
          soloRateUp: servant.soloRateUp,
        }));
        return signature(featured) === signature(savedBanner.featured)
          ? []
          : [{ bannerId: savedBanner.id, featured }];
      });
      if (changes.length) {
        await tx.bannerServant.deleteMany({
          where: { bannerId: { in: changes.map((change) => change.bannerId) } },
        });
        await tx.bannerServant.createMany({
          data: changes.flatMap((change) =>
            change.featured.map((featured) => ({
              bannerId: change.bannerId,
              ...featured,
            })),
          ),
        });
      }
      const heldLineupChanges: {
        bannerId: string;
        sourceKey: string;
        reason: string;
      }[] = [];
      for (const banner of banners) {
        // Missing lineups mean the source has no lineup data, not that existing ones should be deleted.
        if (banner.summonLineups === undefined) continue;
        const savedBanner = keyToBanner.get(bannerSourceKey(banner))!;
        const prefix = `${bannerSourceKey(banner)}:`;
        if (
          owners
            .get(bannerSourceKey(banner))
            ?.sourcePublication?.ownedFields.some(
              (field) => field === "TIMING" || field === "ROSTER",
            )
        ) {
          const desired = banner.summonLineups.map((lineup) => ({
            ...lineup,
            sourceKey: `${prefix}${lineup.sourceKey}`,
            lastVerifiedAt: lineup.lastVerifiedAt ?? null,
          }));
          const existing = savedBanner.summonLineups.map((lineup) => ({
            ...lineup,
            servants: lineup.featured,
          }));
          if (lineupSignature(desired) !== lineupSignature(existing))
            heldLineupChanges.push({
              bannerId: savedBanner.id,
              sourceKey: bannerSourceKey(banner),
              reason: owners
                .get(bannerSourceKey(banner))
                ?.sourcePublication?.ownedFields.includes("ROSTER")
                ? "ROSTER_OWNED_LINEUP_REQUIRES_REVIEW"
                : "TIMING_OWNED_LINEUP_REQUIRES_REVIEW",
            });
          continue;
        }
        const savedKeys: string[] = [];
        for (const lineup of banner.summonLineups) {
          const sourceKey = `${prefix}${lineup.sourceKey}`;
          const data = {
            bannerId: savedBanner.id,
            name: lineup.name,
            startsAt: new Date(lineup.startsAt),
            endsAt: lineup.endsAt ? new Date(lineup.endsAt) : null,
            evidenceUrl: lineup.evidenceUrl,
            sourceRegion: lineup.sourceRegion,
            lastVerifiedAt: lineup.lastVerifiedAt
              ? new Date(lineup.lastVerifiedAt)
              : null,
          };
          const record = await tx.summonLineup.upsert({
            where: { sourceKey },
            create: { sourceKey, ...data },
            update: data,
          });
          savedKeys.push(sourceKey);
          await tx.summonLineupServant.deleteMany({
            where: { lineupId: record.id },
          });
          if (lineup.servants.length)
            await tx.summonLineupServant.createMany({
              data: lineup.servants.map((servant) => ({
                lineupId: record.id,
                ...servant,
              })),
              skipDuplicates: true,
            });
        }
        await tx.summonLineup.deleteMany({
          where: {
            bannerId: savedBanner.id,
            sourceKey: { startsWith: prefix, notIn: savedKeys },
          },
        });
      }
      return {
        examined: banners.length,
        imported: banners.length,
        changedBanners,
        servants: servants.length,
        ...(heldLineupChanges.length ? { heldLineupChanges } : {}),
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}

function lineupSignature(
  rows: {
    sourceKey: string;
    name: string;
    startsAt: string | Date;
    endsAt: string | Date | null;
    sourceRegion: string;
    evidenceUrl: string;
    lastVerifiedAt: string | Date | null;
    servants: { servantId: number; soloRateUp: boolean }[];
  }[],
) {
  return JSON.stringify(
    rows
      .map((row) => ({
        sourceKey: row.sourceKey,
        name: row.name,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        sourceRegion: row.sourceRegion,
        evidenceUrl: row.evidenceUrl,
        lastVerifiedAt: row.lastVerifiedAt
          ? new Date(row.lastVerifiedAt).toISOString()
          : null,
        servants: [...row.servants]
          .sort((a, b) => a.servantId - b.servantId)
          .map(({ servantId, soloRateUp }) => ({ servantId, soloRateUp })),
      }))
      .sort((a, b) =>
        a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0,
      ),
  );
}
