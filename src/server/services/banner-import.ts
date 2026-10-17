import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { bannerDatasetSchema, bannerSourceKey } from "./banner-spreadsheet";
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
      startsAt: `${banner.startDate}T00:00:00Z`,
      endsAt: banner.endDate ? `${banner.endDate}T00:00:00Z` : null,
      status: banner.status === "CONFIRMED_EN" ? "OFFICIAL" : banner.status,
      sourceRegion: banner.sourceSchedule === "NA" ? "NA" : "JP_PROJECTED",
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return database.$transaction(
    async (tx) => {
      if (authorize) await authorize(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
      await tx.$executeRaw`INSERT INTO "Servant" ("id","name","className","rarity","faceId")
      SELECT x."id",x."name",x."className",x."rarity",x."faceId"
      FROM jsonb_to_recordset(${JSON.stringify(servants)}::jsonb) AS x("id" INT,"name" TEXT,"className" TEXT,"rarity" INT,"faceId" INT)
      ORDER BY x."id"
      ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name","className"=EXCLUDED."className","rarity"=EXCLUDED."rarity","faceId"=COALESCE(EXCLUDED."faceId","Servant"."faceId")
      WHERE ("Servant"."name","Servant"."className","Servant"."rarity","Servant"."faceId") IS DISTINCT FROM (EXCLUDED."name",EXCLUDED."className",EXCLUDED."rarity",COALESCE(EXCLUDED."faceId","Servant"."faceId"))`;
      const changedBanners =
        await tx.$executeRaw`INSERT INTO "Banner" ("id","sourceKey","name","startsAt","endsAt","startsAtPrecision","endsAtPrecision","status","sourceRegion","updatedAt")
      SELECT x."id",x."sourceKey",x."name",x."startsAt",x."endsAt",'DATE_ONLY'::"ScheduleTimePrecision",CASE WHEN x."endsAt" IS NULL THEN NULL ELSE 'DATE_ONLY'::"ScheduleTimePrecision" END,x."status"::"ScheduleStatus",x."sourceRegion",CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS x("id" TEXT,"sourceKey" TEXT,"name" TEXT,"startsAt" TIMESTAMP,"endsAt" TIMESTAMP,"status" TEXT,"sourceRegion" TEXT)
      ORDER BY x."sourceKey"
      ON CONFLICT ("sourceKey") DO UPDATE SET "name"=EXCLUDED."name","startsAt"=EXCLUDED."startsAt","endsAt"=EXCLUDED."endsAt","startsAtPrecision"=EXCLUDED."startsAtPrecision","endsAtPrecision"=EXCLUDED."endsAtPrecision","status"=EXCLUDED."status","sourceRegion"=EXCLUDED."sourceRegion","updatedAt"=CURRENT_TIMESTAMP
      WHERE ("Banner"."name","Banner"."startsAt","Banner"."endsAt","Banner"."startsAtPrecision","Banner"."endsAtPrecision","Banner"."status","Banner"."sourceRegion") IS DISTINCT FROM (EXCLUDED."name",EXCLUDED."startsAt",EXCLUDED."endsAt",EXCLUDED."startsAtPrecision",EXCLUDED."endsAtPrecision",EXCLUDED."status",EXCLUDED."sourceRegion")`;
      const saved = await tx.banner.findMany({
        where: { sourceKey: { in: records.map((record) => record.sourceKey) } },
        select: {
          id: true,
          sourceKey: true,
          featured: { select: { servantId: true, soloRateUp: true } },
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
      for (const banner of banners) {
        // Missing lineups mean the source has no lineup data, not that existing ones should be deleted.
        if (banner.summonLineups === undefined) continue;
        const savedBanner = keyToBanner.get(bannerSourceKey(banner))!;
        const prefix = `${bannerSourceKey(banner)}:`;
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
      };
    },
    {
      maxWait: GLOBAL_SOURCE_LIMITS.transactionMaxWaitMs,
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
