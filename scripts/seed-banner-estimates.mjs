import { readFile } from "node:fs/promises";

import { PrismaClient } from "../generated/prisma/index.js";

const db = new PrismaClient();

function parseDate(value) {
  if (!value) return null;

  // Treat spreadsheet values as date-only values rather than local timestamps.
  return new Date(`${value}T00:00:00.000Z`);
}

function createSourceKey(banner) {
  return [
    banner.name.trim().toLowerCase(),
    banner.startDate,
    banner.endDate ?? "",
  ].join(":");
}

async function loadDataset() {
  const contents = await readFile(
    new URL("../data/banner-estimates.json", import.meta.url),
    "utf8",
  );

  return JSON.parse(contents);
}

async function importServants(banners) {
  const servants = new Map();

  for (const banner of banners) {
    for (const servant of banner.servants) {
      servants.set(servant.id, {
        id: servant.id,
        name: servant.name,
        className: servant.class,
        rarity: servant.rarity ?? null,
        ...(Number.isInteger(servant.faceId) && servant.faceId > 0
          ? { faceId: servant.faceId }
          : {}),
      });
    }
  }

  for (const servant of servants.values()) {
    await db.servant.upsert({
      where: {
        id: servant.id,
      },
      create: servant,
      update: {
        name: servant.name,
        className: servant.className,
        rarity: servant.rarity,
        ...(servant.faceId ? { faceId: servant.faceId } : {}),
      },
    });
  }

  return servants.size;
}

async function importBanner(banner) {
  const sourceKey = createSourceKey(banner);

  return db.$transaction(async (transaction) => {
    const savedBanner = await transaction.banner.upsert({
      where: {
        sourceKey,
      },
      create: {
        sourceKey,
        name: banner.name,
        startsAt: parseDate(banner.startDate),
        startsAtPrecision: "DATE_ONLY",
        endsAt: parseDate(banner.endDate),
        endsAtPrecision: banner.endDate ? "DATE_ONLY" : null,
        status: banner.status === "CONFIRMED_EN" ? "OFFICIAL" : banner.status,
        sourceRegion: banner.sourceSchedule === "NA" ? "NA" : "JP_PROJECTED",
      },
      update: {
        name: banner.name,
        startsAt: parseDate(banner.startDate),
        startsAtPrecision: "DATE_ONLY",
        endsAt: parseDate(banner.endDate),
        endsAtPrecision: banner.endDate ? "DATE_ONLY" : null,
        status: banner.status === "CONFIRMED_EN" ? "OFFICIAL" : banner.status,
        sourceRegion: banner.sourceSchedule === "NA" ? "NA" : "JP_PROJECTED",
      },
    });

    // Reconcile featured Servants with the latest spreadsheet data.
    await transaction.bannerServant.deleteMany({
      where: {
        bannerId: savedBanner.id,
      },
    });

    if (banner.servants.length > 0) {
      await transaction.bannerServant.createMany({
        data: banner.servants.map((servant) => ({
          bannerId: savedBanner.id,
          servantId: servant.id,
          soloRateUp: servant.soloRateUp,
        })),
        skipDuplicates: true,
      });
    }

    const savedLineupKeys = [];
    for (const lineup of banner.summonLineups ?? []) {
      const lineupSourceKey = `${sourceKey}:${lineup.sourceKey}`;
      const savedLineup = await transaction.summonLineup.upsert({
        where: { sourceKey: lineupSourceKey },
        create: {
          sourceKey: lineupSourceKey,
          bannerId: savedBanner.id,
          name: lineup.name,
          startsAt: new Date(lineup.startsAt),
          endsAt: lineup.endsAt ? new Date(lineup.endsAt) : null,
          evidenceUrl: lineup.evidenceUrl,
          sourceRegion: lineup.sourceRegion,
          lastVerifiedAt: lineup.lastVerifiedAt
            ? new Date(lineup.lastVerifiedAt)
            : null,
        },
        update: {
          bannerId: savedBanner.id,
          name: lineup.name,
          startsAt: new Date(lineup.startsAt),
          endsAt: lineup.endsAt ? new Date(lineup.endsAt) : null,
          evidenceUrl: lineup.evidenceUrl,
          sourceRegion: lineup.sourceRegion,
          lastVerifiedAt: lineup.lastVerifiedAt
            ? new Date(lineup.lastVerifiedAt)
            : null,
        },
      });
      savedLineupKeys.push(lineupSourceKey);

      await transaction.summonLineupServant.deleteMany({
        where: { lineupId: savedLineup.id },
      });
      if (lineup.servants.length > 0) {
        await transaction.summonLineupServant.createMany({
          data: lineup.servants.map((servant) => ({
            lineupId: savedLineup.id,
            servantId: servant.servantId,
            soloRateUp: servant.soloRateUp,
          })),
          skipDuplicates: true,
        });
      }
    }

    await transaction.summonLineup.deleteMany({
      where: {
        bannerId: savedBanner.id,
        sourceKey: { notIn: savedLineupKeys },
      },
    });
  });
}

async function main() {
  const dataset = await loadDataset();

  console.log(`Reading ${dataset.count} normalized banners`);

  const servantCount = await importServants(dataset.banners);

  let importedBanners = 0;

  for (const banner of dataset.banners) {
    await importBanner(banner);
    importedBanners += 1;

    console.log(
      `[${importedBanners}/${dataset.banners.length}] ${banner.name}`,
    );
  }

  console.log(
    `Imported ${importedBanners} banners and ${servantCount} Servants.`,
  );
}

try {
  await main();
} catch (error) {
  console.error("Banner import failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
