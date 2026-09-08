import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "../generated/prisma/index.js";
import { parseApprovedEventDataset } from "./lib/event-dataset.mjs";

const db = new PrismaClient();

function resolveDatasetPath() {
  const value = process.argv[2] ?? process.env.EVENT_DATA_PATH?.trim();
  if (!value) throw new Error("EVENT_DATA_PATH is required.");
  return path.resolve(value);
}

function toDate(value) {
  return value ? new Date(value) : null;
}

async function loadDataset() {
  const contents = await readFile(resolveDatasetPath(), "utf8");
  return parseApprovedEventDataset(JSON.parse(contents));
}

async function importFamily(family) {
  return db.eventFamily.upsert({
    where: { sourceKey: family.sourceKey },
    create: {
      ...family,
      artworkReviewedAt: toDate(family.artworkReviewedAt),
    },
    update: {
      name: family.name,
      artworkUrl: family.artworkUrl,
      artworkSourceUrl: family.artworkSourceUrl,
      artworkAlt: family.artworkAlt,
      artworkReviewedAt: toDate(family.artworkReviewedAt),
    },
  });
}

async function importEvent(event, familyIds) {
  const data = {
    name: event.name,
    type: event.type,
    startsAt: new Date(event.startsAt),
    startsAtPrecision: event.startsAtPrecision,
    endsAt: toDate(event.endsAt),
    endsAtPrecision: event.endsAtPrecision,
    status: event.status,
    sourceUrl: event.sourceUrl,
    sourceRegion: event.sourceRegion,
    sourceStartsAt: toDate(event.sourceStartsAt),
    sourceEndsAt: toDate(event.sourceEndsAt),
    projectionMethod: event.projectionMethod,
    lastSyncedAt: toDate(event.lastSyncedAt),
    sourceContentHash: event.sourceContentHash,
    familyId: event.familySourceKey
      ? familyIds.get(event.familySourceKey)
      : null,
  };

  return db.event.upsert({
    where: { sourceKey: event.sourceKey },
    create: { sourceKey: event.sourceKey, ...data },
    update: data,
  });
}

async function importRewardSource(source, eventIds, externalEventIds) {
  return db.$transaction(async (transaction) => {
    const data = {
      eventId: source.eventSourceKey
        ? eventIds.get(source.eventSourceKey)
        : source.externalEventSourceKey
          ? externalEventIds.get(source.externalEventSourceKey)
          : null,
      name: source.name,
      type: source.type,
      status: source.status,
      evidenceUrl: source.evidenceUrl,
      lastVerifiedAt: toDate(source.lastVerifiedAt),
    };
    const savedSource = await transaction.rewardSource.upsert({
      where: { sourceKey: source.sourceKey },
      create: { sourceKey: source.sourceKey, ...data },
      update: data,
    });

    for (const reward of source.rewards) {
      const rewardData = {
        rewardSourceId: savedSource.id,
        itemType: reward.itemType,
        amount: reward.amount,
        expectedAt: toDate(reward.expectedAt),
        nature: reward.nature,
        eligibility: reward.eligibility,
        defaultIncluded: reward.defaultIncluded,
        reviewedAt: toDate(reward.reviewedAt),
      };

      await transaction.rewardDefinition.upsert({
        where: { sourceKey: reward.sourceKey },
        create: { sourceKey: reward.sourceKey, ...rewardData },
        update: rewardData,
      });
    }

    await transaction.rewardDefinition.deleteMany({
      where: {
        rewardSourceId: savedSource.id,
        sourceKey: { notIn: source.rewards.map(({ sourceKey }) => sourceKey) },
      },
    });

    return savedSource;
  });
}

async function main() {
  const dataset = await loadDataset();
  const familyIds = new Map();
  const eventIds = new Map();
  const externalEventKeys = [
    ...new Set(
      dataset.rewardSources.flatMap(({ externalEventSourceKey }) =>
        externalEventSourceKey ? [externalEventSourceKey] : [],
      ),
    ),
  ];
  const externalEvents = await db.event.findMany({
    where: { sourceKey: { in: externalEventKeys } },
    select: { id: true, sourceKey: true },
  });
  const externalEventIds = new Map(
    externalEvents.map(({ sourceKey, id }) => [sourceKey, id]),
  );
  const missingExternalEvents = externalEventKeys.filter(
    (sourceKey) => !externalEventIds.has(sourceKey),
  );
  if (missingExternalEvents.length > 0) {
    throw new Error(
      `Referenced events have not been imported: ${missingExternalEvents.join(", ")}.`,
    );
  }

  console.log(
    `Importing approved event dataset generated at ${dataset.generatedAt}`,
  );

  for (const family of dataset.families) {
    const savedFamily = await importFamily(family);
    familyIds.set(family.sourceKey, savedFamily.id);
  }

  for (const event of dataset.events) {
    const savedEvent = await importEvent(event, familyIds);
    eventIds.set(event.sourceKey, savedEvent.id);
  }

  for (const source of dataset.rewardSources) {
    await importRewardSource(source, eventIds, externalEventIds);
  }

  for (const issue of dataset.issues) {
    console.log(`[${issue.severity}] ${issue.message}`);
  }

  console.log(
    `Imported ${dataset.families.length} event family, ${dataset.events.length} events, and ${dataset.rewardSources.length} reward sources.`,
  );
}

try {
  await main();
} catch (error) {
  console.error("Event data import failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
