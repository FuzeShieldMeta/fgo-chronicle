import { parseEventDataset } from "./event-dataset.mjs";
import { addCalendarYears, planEventReconciliation } from "./jp-event-sync.mjs";

const SYNC_SOURCE = "ATLAS_JP_EVENT_EXPORT";

/** @param {string | null | undefined} value */
function toDate(value) {
  return value ? new Date(value) : null;
}

/** @param {Record<string, any>} event */
function eventData(event) {
  return {
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
  };
}

/** @param {Record<string, any>} reward @param {string} rewardSourceId */
function rewardData(reward, rewardSourceId) {
  return {
    rewardSourceId,
    itemType: reward.itemType,
    amount: reward.amount,
    expectedAt: toDate(reward.expectedAt),
    nature: reward.nature,
    eligibility: reward.eligibility,
    defaultIncluded: reward.defaultIncluded,
    reviewedAt: toDate(reward.reviewedAt),
  };
}

/**
 * @param {Record<string, any>} transaction
 * @param {Record<string, any>} family
 * @param {Record<string, any> | null | undefined} existingFamily
 */
async function saveFamily(transaction, family, existingFamily) {
  const data = {
    name: family.name,
    artworkUrl: family.artworkUrl,
    artworkSourceUrl: family.artworkSourceUrl,
    artworkAlt: family.artworkAlt,
    artworkReviewedAt: toDate(family.artworkReviewedAt),
  };

  return transaction.eventFamily.upsert({
    where: { sourceKey: family.sourceKey },
    create: { sourceKey: family.sourceKey, ...data },
    update: existingFamily?.artworkReviewedAt ? {} : data,
  });
}

/**
 * @param {Record<string, any>} transaction
 * @param {Record<string, any>} source
 * @param {string} eventId
 * @param {Map<string, Record<string, any>>} existingRewards
 */
async function saveRewardSource(transaction, source, eventId, existingRewards) {
  const savedSource = await transaction.rewardSource.upsert({
    where: { sourceKey: source.sourceKey },
    create: {
      sourceKey: source.sourceKey,
      eventId,
      name: source.name,
      type: source.type,
      status: source.status,
      evidenceUrl: source.evidenceUrl,
      lastVerifiedAt: toDate(source.lastVerifiedAt),
    },
    update: {
      eventId,
      name: source.name,
      type: source.type,
      status: source.status,
      evidenceUrl: source.evidenceUrl,
    },
  });

  for (const reward of source.rewards) {
    const existing = existingRewards.get(reward.sourceKey);
    if (existing?.reviewedAt) continue;

    const data = rewardData(reward, savedSource.id);
    await transaction.rewardDefinition.upsert({
      where: { sourceKey: reward.sourceKey },
      create: { sourceKey: reward.sourceKey, ...data },
      update: data,
    });
  }
}

/**
 * @param {Record<string, any>} db
 * @param {Record<string, any>} inputDataset
 * @param {{asOf: Date, dryRun?: boolean, maxUpdates?: number, syncRunId?: string | null}} options
 */
export async function reconcileProjectedJpEvents(db, inputDataset, options) {
  const dataset = parseEventDataset(inputDataset);
  const sourceFrom = addCalendarYears(options.asOf, -2);
  const existingEvents = /** @type {Array<Record<string, any>>} */ (
    await db.event.findMany({
      where: {
        sourceRegion: "JP",
        projectionMethod: "TWO_CALENDAR_YEARS",
        sourceStartsAt: { lte: options.asOf },
        sourceEndsAt: { gte: sourceFrom },
      },
      include: {
        family: true,
        rewardSources: { include: { rewards: true } },
      },
    })
  );
  const plan = planEventReconciliation(
    dataset.events,
    existingEvents,
    options.asOf,
  );
  const maxUpdates = options.maxUpdates ?? 25;
  if (plan.updates.length > maxUpdates) {
    throw new Error(
      `The sync proposed ${plan.updates.length} updates. The limit is ${maxUpdates}. Run a dry run and inspect the source.`,
    );
  }

  const rewardCount = dataset.rewardSources.reduce(
    (count, source) => count + source.rewards.length,
    0,
  );
  const warningCount =
    dataset.issues.length +
    plan.frozenDifferences.length +
    plan.protectedDifferences.length +
    plan.missingSourceKeys.length;
  const report = {
    fetched: inputDataset.stats?.fetched ?? dataset.events.length,
    selected: dataset.events.length,
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    unchangedMutable: plan.unchangedMutable.length,
    frozenDifferences: plan.frozenDifferences.length,
    protectedDifferences: plan.protectedDifferences.length,
    missingSourceRecords: plan.missingSourceKeys.length,
    rewardDefinitions: rewardCount,
    omittedRewards: dataset.issues.length,
    warnings: warningCount,
    dryRun: Boolean(options.dryRun),
  };
  if (options.dryRun) return report;

  const contentHash = dataset.events[0]?.sourceContentHash ?? null;
  const syncRun = options.syncRunId
    ? { id: options.syncRunId }
    : await db.syncRun.create({
        data: {
          source: SYNC_SOURCE,
          status: "RUNNING",
          contentHash,
          fetchedCount: report.fetched,
          selectedCount: report.selected,
        },
      });

  try {
    const families = new Map(
      dataset.families.map((family) => [family.sourceKey, family]),
    );
    const rewardsByEvent = new Map();
    for (const source of dataset.rewardSources) {
      const sources = rewardsByEvent.get(source.eventSourceKey) ?? [];
      sources.push(source);
      rewardsByEvent.set(source.eventSourceKey, sources);
    }
    const existingByKey = new Map(
      existingEvents.map((/** @type {Record<string, any>} */ event) => [
        event.sourceKey,
        event,
      ]),
    );
    const fullWrites = [...plan.inserts, ...plan.updates];
    const metadataWrites = plan.unchangedMutable;

    await db.$transaction(
      async (/** @type {Record<string, any>} */ transaction) => {
        const [lock] = await transaction.$queryRawUnsafe(
          "SELECT pg_try_advisory_xact_lock(734621905) AS acquired",
        );
        if (!lock?.acquired) {
          throw new Error("Another JP event synchronisation is running.");
        }

        for (const event of fullWrites) {
          const existing = existingByKey.get(event.sourceKey);
          const family = families.get(event.familySourceKey);
          if (!family) {
            throw new Error(`Event ${event.sourceKey} has no event family.`);
          }
          const savedFamily = await saveFamily(
            transaction,
            family,
            existing?.family,
          );
          const data = { ...eventData(event), familyId: savedFamily.id };
          const savedEvent = await transaction.event.upsert({
            where: { sourceKey: event.sourceKey },
            create: { sourceKey: event.sourceKey, ...data },
            update: data,
          });
          const existingRewards = new Map(
            (existing?.rewardSources ?? [])
              .flatMap(
                (/** @type {Record<string, any>} */ source) => source.rewards,
              )
              .map((/** @type {Record<string, any>} */ reward) => [
                reward.sourceKey,
                reward,
              ]),
          );
          for (const source of rewardsByEvent.get(event.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              savedEvent.id,
              existingRewards,
            );
          }
        }

        for (const event of metadataWrites) {
          const existing = existingByKey.get(event.sourceKey);
          if (!existing) {
            throw new Error(
              `Mutable event ${event.sourceKey} disappeared during reconciliation.`,
            );
          }
          await transaction.event.update({
            where: { sourceKey: event.sourceKey },
            data: {
              lastSyncedAt: toDate(event.lastSyncedAt),
              sourceContentHash: event.sourceContentHash,
            },
          });
          const existingRewards = new Map(
            (existing?.rewardSources ?? [])
              .flatMap(
                (/** @type {Record<string, any>} */ source) => source.rewards,
              )
              .map((/** @type {Record<string, any>} */ reward) => [
                reward.sourceKey,
                reward,
              ]),
          );
          for (const source of rewardsByEvent.get(event.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              existing.id,
              existingRewards,
            );
          }
        }

        await transaction.syncRun.update({
          where: { id: syncRun.id },
          data: {
            status: "SUCCEEDED",
            completedAt: new Date(),
            contentHash,
            fetchedCount: report.fetched,
            selectedCount: report.selected,
            insertedCount: report.inserted,
            updatedCount: report.updated,
            frozenDifferenceCount: report.frozenDifferences,
            rewardCount: report.rewardDefinitions,
            omittedRewardCount: report.omittedRewards,
            warningCount: report.warnings,
          },
        });
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    return report;
  } catch (error) {
    try {
      await db.syncRun.update({
        where: { id: syncRun.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : String(error),
        },
      });
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "JP event synchronisation failed and its failure could not be recorded.",
      );
    }
    if (error && typeof error === "object") {
      Object.defineProperty(error, "syncRunFailureRecorded", {
        value: true,
        enumerable: false,
      });
    }
    throw error;
  }
}
