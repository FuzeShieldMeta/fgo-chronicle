import {
  countEventRewardChanges,
  rewardDateBasisChanged,
  checkReconciliationLimits,
  isProtectedRewardSource,
} from "./reward-reconciliation.mjs";
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
    dateBasis: reward.dateBasis ?? "UNKNOWN",
    nature: reward.nature,
    eligibility: reward.eligibility,
    storyWarId: reward.storyWarId ?? null,
    storyReleaseAt: toDate(reward.storyReleaseAt),
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
 * @param {{insertMissingOnly?: boolean, existingSource?: Record<string, any>}} [options]
 */
async function saveRewardSource(
  transaction,
  source,
  eventId,
  existingRewards,
  options = {},
) {
  if (options.existingSource && isProtectedRewardSource(options.existingSource))
    return;
  const rewards = options.insertMissingOnly
    ? source.rewards.filter(
        (/** @type {Record<string, any>} */ reward) =>
          !existingRewards.has(reward.sourceKey) ||
          rewardDateBasisChanged(existingRewards.get(reward.sourceKey), reward),
      )
    : source.rewards;
  if (rewards.length === 0) return;

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
    update: options.insertMissingOnly
      ? {}
      : {
          eventId,
          name: source.name,
          type: source.type,
          status: source.status,
          evidenceUrl: source.evidenceUrl,
        },
  });

  for (const reward of rewards) {
    const existing = existingRewards.get(reward.sourceKey);
    if (existing && (existing.reviewedAt || options.insertMissingOnly)) {
      if (rewardDateBasisChanged(existing, reward)) {
        await transaction.rewardDefinition.update({
          where: { sourceKey: reward.sourceKey },
          data: { dateBasis: reward.dateBasis ?? "UNKNOWN" },
        });
      }
      continue;
    }

    const data = rewardData(reward, savedSource.id);
    await transaction.rewardDefinition.upsert({
      where: { sourceKey: reward.sourceKey },
      create: { sourceKey: reward.sourceKey, ...data },
      update: data,
    });
  }
}

/**
 * Return obsolete unreviewed reward sources owned by the Atlas event adapter.
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 */
function obsoleteAtlasRewardSourceIds(event, desiredSources) {
  const eventId = /^atlas:JP:event:(\d+):projection:NA$/.exec(
    event.sourceKey ?? "",
  )?.[1];
  if (!eventId) return [];
  const desiredKeys = new Set(desiredSources.map(({ sourceKey }) => sourceKey));
  const ownedPrefix = `atlas:${eventId}:`;

  return (event.rewardSources ?? [])
    .filter(
      (/** @type {Record<string, any>} */ source) =>
        source.sourceKey?.startsWith(ownedPrefix) &&
        !isProtectedRewardSource(source) &&
        !desiredKeys.has(source.sourceKey) &&
        (source.rewards ?? []).every(
          (/** @type {Record<string, any>} */ reward) =>
            !reward.reviewedAt &&
            !reward.curation &&
            !reward.reviews?.length &&
            !reward.globalBaseline,
        ),
    )
    .flatMap((/** @type {Record<string, any>} */ source) =>
      typeof source.id === "string" ? [source.id] : [],
    );
}

/**
 * @param {Record<string, any>} transaction
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 */
async function removeObsoleteAtlasRewardSources(
  transaction,
  event,
  desiredSources,
) {
  const ids = obsoleteAtlasRewardSourceIds(event, desiredSources);
  if (ids.length === 0) return;
  await transaction.rewardSource.deleteMany({
    where: {
      id: { in: ids },
      rewards: { none: { globalBaseline: { isNot: null } } },
    },
  });
}

/**
 * @param {Record<string, any>} db
 * @param {Record<string, any>} inputDataset
 * @param {{asOf: Date, dryRun?: boolean, maxUpdates?: number, maxRewardChanges?: number, syncRunId?: string | null}} options
 */
export async function reconcileProjectedJpEvents(db, inputDataset, options) {
  const dataset = parseEventDataset(inputDataset);
  const sourceFrom = addCalendarYears(options.asOf, -2);
  const existingEvents = /** @type {Array<Record<string, any>>} */ (
    await db.event.findMany({
      where: {
        sourceKey: { startsWith: "atlas:JP:event:" },
        sourceRegion: "JP",
        projectionMethod: "TWO_CALENDAR_YEARS",
        sourceStartsAt: { lte: options.asOf },
        sourceEndsAt: { gte: sourceFrom },
      },
      include: {
        family: true,
        rewardSources: {
          include: {
            rewards: {
              include: {
                curation: true,
                globalBaseline: { select: { rewardId: true } },
                reviews: { select: { id: true }, take: 1 },
              },
            },
          },
        },
      },
    })
  );
  const plan = planEventReconciliation(
    dataset.events,
    existingEvents,
    options.asOf,
  );
  const maxUpdates = options.maxUpdates ?? 25;

  const rewardCount = dataset.rewardSources.reduce(
    (count, source) => count + source.rewards.length,
    0,
  );
  const desiredRewardsByEvent = new Map();
  for (const source of dataset.rewardSources) {
    const values = desiredRewardsByEvent.get(source.eventSourceKey) ?? [];
    values.push(source);
    desiredRewardsByEvent.set(source.eventSourceKey, values);
  }
  const maintainedExistingEvents = [
    ...plan.updates,
    ...plan.unchangedMutable,
    ...plan.unchangedFrozen,
    ...plan.frozenDifferences,
  ].flatMap(({ sourceKey }) => {
    const existing = existingEvents.find(
      (event) => event.sourceKey === sourceKey,
    );
    return existing ? [existing] : [];
  });
  const obsoleteRewardSources = maintainedExistingEvents
    .filter((event) => new Date(event.endsAt) >= options.asOf)
    .reduce(
      (count, event) =>
        count +
        obsoleteAtlasRewardSourceIds(
          event,
          desiredRewardsByEvent.get(event.sourceKey) ?? [],
        ).length,
      0,
    );
  const frozenKeys = new Set(
    [...plan.unchangedFrozen, ...plan.frozenDifferences].map(
      ({ sourceKey }) => sourceKey,
    ),
  );
  const maintainedEvents = maintainedExistingEvents.filter(
    (event) =>
      !frozenKeys.has(event.sourceKey) ||
      new Date(event.endsAt) >= options.asOf,
  );
  const rewardChanges = maintainedEvents.reduce((count, event) => {
    const desired = desiredRewardsByEvent.get(event.sourceKey) ?? [];
    return (
      count +
      countEventRewardChanges(event, desired, {
        insertMissingOnly: frozenKeys.has(event.sourceKey),
        obsoleteSourceIds: obsoleteAtlasRewardSourceIds(event, desired),
      })
    );
  }, 0);
  const limits = checkReconciliationLimits({
    eventChanges: plan.updates.length,
    rewardChanges,
    maxUpdates,
    maxRewardChanges: options.maxRewardChanges ?? 250,
    dryRun: options.dryRun,
  });
  const warningCount =
    dataset.issues.length +
    plan.frozenDifferences.length +
    plan.protectedDifferences.length +
    plan.missingSourceKeys.length;
  const report = {
    ...limits,
    fetched: inputDataset.stats?.fetched ?? dataset.events.length,
    selected: dataset.events.length,
    trackedEventGiftLocations:
      inputDataset.stats?.trackedEventGiftLocations ?? 0,
    trackedEventShopTargets: inputDataset.stats?.trackedEventShopTargets ?? 0,
    unknownEventGiftLocations:
      inputDataset.stats?.unknownEventGiftLocations ?? 0,
    eventsWithWarsChecked: inputDataset.stats?.eventsWithWarsChecked ?? 0,
    playableEventsSelected: inputDataset.stats?.playableEventsSelected ?? 0,
    playableEventsWithWarsChecked:
      inputDataset.stats?.playableEventsWithWarsChecked ?? 0,
    playableEventsWithoutSafeWar:
      inputDataset.stats?.playableEventsWithoutSafeWar ?? 0,
    playableEventsShadowedByFiniteRelease:
      inputDataset.stats?.playableEventsShadowedByFiniteRelease ?? 0,
    eventWarAssociationsChecked:
      inputDataset.stats?.eventWarAssociationsChecked ?? 0,
    uniqueWarsChecked: inputDataset.stats?.uniqueWarsChecked ?? 0,
    warsWithTrackedRewards: inputDataset.stats?.warsWithTrackedRewards ?? 0,
    warRewardDefinitions: inputDataset.stats?.warRewardDefinitions ?? 0,
    trackedWarGiftLocations: inputDataset.stats?.trackedWarGiftLocations ?? 0,
    questPresentGiftLocations:
      inputDataset.stats?.questPresentGiftLocations ?? 0,
    ignoredSelectionGiftLocations:
      inputDataset.stats?.ignoredSelectionGiftLocations ?? 0,
    ignoredSpotGiftLocations: inputDataset.stats?.ignoredSpotGiftLocations ?? 0,
    eligibleSelectionGiftLocations:
      inputDataset.stats?.eligibleSelectionGiftLocations ?? 0,
    replacementGiftLocations: inputDataset.stats?.replacementGiftLocations ?? 0,
    unknownWarGiftLocations: inputDataset.stats?.unknownWarGiftLocations ?? 0,
    missingReferencedWars: inputDataset.stats?.missingReferencedWars ?? 0,
    inferredWarAssociations: inputDataset.stats?.inferredWarAssociations ?? 0,
    unresolvedPlayableWarAssociations:
      inputDataset.stats?.unresolvedPlayableWarAssociations ?? 0,
    ambiguousPlayableWarAssociations:
      inputDataset.stats?.ambiguousPlayableWarAssociations ?? 0,
    obsoleteRewardSources,
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
    const rewardEnrichmentCandidates = [
      ...plan.unchangedFrozen,
      ...plan.frozenDifferences,
    ].filter((event) => new Date(event.endsAt) >= options.asOf);

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
          const desiredSources = rewardsByEvent.get(event.sourceKey) ?? [];
          if (existing) {
            await removeObsoleteAtlasRewardSources(
              transaction,
              existing,
              desiredSources,
            );
          }
          for (const source of desiredSources) {
            await saveRewardSource(
              transaction,
              source,
              savedEvent.id,
              existingRewards,
              {
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
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
          const desiredSources = rewardsByEvent.get(event.sourceKey) ?? [];
          await removeObsoleteAtlasRewardSources(
            transaction,
            existing,
            desiredSources,
          );
          for (const source of desiredSources) {
            await saveRewardSource(
              transaction,
              source,
              existing.id,
              existingRewards,
              {
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
            );
          }
        }

        for (const event of rewardEnrichmentCandidates) {
          const existing = existingByKey.get(event.sourceKey);
          if (!existing) continue;
          const existingRewards = new Map(
            (existing.rewardSources ?? [])
              .flatMap(
                (/** @type {Record<string, any>} */ source) => source.rewards,
              )
              .map((/** @type {Record<string, any>} */ reward) => [
                reward.sourceKey,
                reward,
              ]),
          );
          const desiredSources = rewardsByEvent.get(event.sourceKey) ?? [];
          await removeObsoleteAtlasRewardSources(
            transaction,
            existing,
            desiredSources,
          );
          for (const source of desiredSources) {
            await saveRewardSource(
              transaction,
              source,
              existing.id,
              existingRewards,
              {
                insertMissingOnly: true,
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
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
