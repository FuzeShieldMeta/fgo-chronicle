import {
  eventRewardChangeBreakdown,
  rewardDateBasisChanged,
  rewardContentChanged,
  checkReconciliationLimits,
  isProtectedRewardSource,
} from "./reward-reconciliation.mjs";
import { parseEventDataset } from "./event-dataset.mjs";
import { addCalendarYears, planEventReconciliation } from "./jp-event-sync.mjs";
import { IMPORT_WRITE_LIMITS } from "../../src/shared/import-write-config.mjs";
import {
  countImportIssues,
  safeSyncFailure,
} from "./event-schedule-monitoring.mjs";

const FANDOM_SYNC_SOURCE = "FANDOM_JP_COVERAGE";
const FANDOM_SYNC_ADVISORY_LOCK_ID = 734621906;

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
 * Publish records backed by a fetched detail page. List-only and erroneous
 * candidates remain in the review dataset.
 * @param {Record<string, any>} inputDataset
 */
export function selectPublishableFandomDataset(inputDataset) {
  const dataset = parseEventDataset(inputDataset);
  const errorKeys = dataset.issues
    .filter(({ severity }) => severity === "ERROR")
    .map(({ sourceKey }) => sourceKey);
  const heldEvents =
    /** @type {Array<{sourceKey: string, name: string, reason: string}>} */ ([]);
  const publishableEvents = dataset.events.filter((event) => {
    if (event.sourceKey.includes(":list-entry:")) {
      heldEvents.push({
        sourceKey: event.sourceKey,
        name: event.name,
        reason: "MISSING_DETAIL_PAGE",
      });
      return false;
    }
    const hasBlockingError = errorKeys.some(
      (key) =>
        key.startsWith(event.sourceKey) ||
        key.startsWith(event.evidenceSourceKey),
    );
    if (hasBlockingError) {
      heldEvents.push({
        sourceKey: event.sourceKey,
        name: event.name,
        reason: "SOURCE_ERROR",
      });
      return false;
    }
    return true;
  });
  const eventKeys = new Set(
    publishableEvents.map(({ sourceKey }) => sourceKey),
  );
  const familyKeys = new Set(
    publishableEvents.flatMap(({ familySourceKey }) =>
      familySourceKey ? [familySourceKey] : [],
    ),
  );
  const rewardSources = dataset.rewardSources.filter(
    ({ eventSourceKey, externalEventSourceKey, evidenceSourceKey }) =>
      (eventSourceKey && eventKeys.has(eventSourceKey)) ||
      (externalEventSourceKey &&
        !errorKeys.some((key) => key.startsWith(evidenceSourceKey))),
  );
  const evidenceKeys = new Set([
    ...publishableEvents.map(({ evidenceSourceKey }) => evidenceSourceKey),
    ...rewardSources.map(({ evidenceSourceKey }) => evidenceSourceKey),
  ]);

  return {
    dataset: {
      ...dataset,
      sources: dataset.sources.filter(({ sourceKey }) =>
        evidenceKeys.has(sourceKey),
      ),
      families: dataset.families.filter(({ sourceKey }) =>
        familyKeys.has(sourceKey),
      ),
      events: publishableEvents,
      rewardSources,
    },
    heldEvents,
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
 * @param {{insertMissingOnly?: boolean, existingSource?: Record<string, any>, metadataUpdates: Map<string, Array<{sourceKey: string, sourceSourceKey: string}>>}} options
 */
async function saveRewardSource(
  transaction,
  source,
  eventId,
  existingRewards,
  options,
) {
  if (options.existingSource && isProtectedRewardSource(options.existingSource))
    return;
  const contentRewards = [];
  for (const reward of source.rewards) {
    const existing = existingRewards.get(reward.sourceKey);
    const contentChange =
      !existing ||
      (!existing.reviewedAt &&
        !options.insertMissingOnly &&
        rewardContentChanged(existing, reward));
    if (contentChange) contentRewards.push(reward);
    else if (rewardDateBasisChanged(existing, reward)) {
      const basis = reward.dateBasis ?? "UNKNOWN";
      const updates = options.metadataUpdates.get(basis) ?? [];
      updates.push({
        sourceKey: reward.sourceKey,
        sourceSourceKey: source.sourceKey,
      });
      options.metadataUpdates.set(basis, updates);
    }
  }
  const sourceChanged =
    !options.existingSource ||
    (!options.insertMissingOnly &&
      ["name", "type", "status", "evidenceUrl"].some(
        (key) => source[key] !== options.existingSource?.[key],
      ));
  if (!sourceChanged && contentRewards.length === 0) return;
  if (source.rewards.length === 0) return;

  const savedSource = sourceChanged
    ? await transaction.rewardSource.upsert({
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
      })
    : options.existingSource;

  for (const reward of contentRewards) {
    if (!savedSource)
      throw new Error("The reward source could not be resolved.");
    const data = rewardData(reward, savedSource.id);
    await transaction.rewardDefinition.upsert({
      where: { sourceKey: reward.sourceKey },
      create: { sourceKey: reward.sourceKey, ...data },
      update: data,
    });
  }
}

/** @param {Record<string, any>} event */
function existingRewardMap(event) {
  return new Map(
    (event?.rewardSources ?? [])
      .flatMap((/** @type {Record<string, any>} */ source) => source.rewards)
      .map((/** @type {Record<string, any>} */ reward) => [
        reward.sourceKey,
        reward,
      ]),
  );
}

/**
 * Return obsolete sources that this pipeline can safely replace. Preserve a
 * complete source when any of its rewards has been reviewed.
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 */
function obsoleteManagedRewardSourceIds(event, desiredSources) {
  const desiredKeys = new Set(desiredSources.map(({ sourceKey }) => sourceKey));
  const ownsAssociatedWarSources = event.sourceKey?.startsWith("fandom:JP:");

  return (event.rewardSources ?? [])
    .filter((/** @type {Record<string, any>} */ source) => {
      const pipelineOwned =
        source.sourceKey?.startsWith("fandom:JP:") ||
        (ownsAssociatedWarSources &&
          source.sourceKey?.startsWith("atlas:JP:war:"));
      return (
        pipelineOwned &&
        source.status === "PROJECTED" &&
        !desiredKeys.has(source.sourceKey) &&
        (source.rewards ?? []).every(
          (/** @type {Record<string, any>} */ reward) =>
            !reward.reviewedAt &&
            !reward.curation &&
            !reward.reviews?.length &&
            !reward.globalBaseline,
        )
      );
    })
    .flatMap((/** @type {Record<string, any>} */ source) =>
      typeof source.id === "string" ? [source.id] : [],
    );
}

/**
 * @param {Record<string, any>} transaction
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 */
async function removeObsoleteRewardSources(transaction, event, desiredSources) {
  const ids = obsoleteManagedRewardSourceIds(event, desiredSources);
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
 * @param {{asOf: Date, dryRun?: boolean, maxUpdates?: number, maxRewardChanges?: number, externalEventSourceKeys?: string[], supersededEvents?: Array<{sourceEventKey: string, targetEventKey: string, matchMethod: string | null, sourceName: string, targetName: string}>}} options
 */
export async function reconcileProjectedFandomEvents(
  db,
  inputDataset,
  options,
) {
  const selected = selectPublishableFandomDataset(inputDataset);
  const dataset = selected.dataset;
  const sourceFrom = addCalendarYears(options.asOf, -2);
  const existingEvents = await db.event.findMany({
    where: {
      sourceKey: { startsWith: "fandom:JP:" },
      sourceRegion: "JP",
      projectionMethod: "TWO_CALENDAR_YEARS",
      sourceStartsAt: { lte: options.asOf },
      sourceEndsAt: { gte: sourceFrom },
    },
    include: {
      family: true,
      curation: true,
      globalBaseline: { select: { eventId: true } },
      reviews: { select: { id: true }, take: 1 },
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
  });
  const plan = planEventReconciliation(
    dataset.events,
    existingEvents,
    options.asOf,
  );
  const maxUpdates = options.maxUpdates ?? 25;

  const externalKeys = [
    ...new Set([
      ...(options.externalEventSourceKeys ?? []),
      ...dataset.rewardSources.flatMap(({ externalEventSourceKey }) =>
        externalEventSourceKey ? [externalEventSourceKey] : [],
      ),
    ]),
  ];
  const externalEvents = externalKeys.length
    ? await db.event.findMany({
        where: { sourceKey: { in: externalKeys } },
        include: {
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
    : [];
  const externalByKey = new Map(
    externalEvents.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      event,
    ]),
  );
  const missingExternalKeys = externalKeys.filter(
    (sourceKey) => !externalByKey.has(sourceKey),
  );
  const supersededMatches = options.supersededEvents ?? [];
  const supersededSourceKeys = [
    ...new Set(supersededMatches.map(({ sourceEventKey }) => sourceEventKey)),
  ];
  const supersededExistingEvents = supersededSourceKeys.length
    ? await db.event.findMany({
        where: { sourceKey: { in: supersededSourceKeys } },
        include: {
          family: true,
          curation: true,
          globalBaseline: { select: { eventId: true } },
          dateEvidence: { select: { id: true }, take: 1 },
          globalCandidates: { select: { id: true }, take: 1 },
          reviews: { select: { id: true }, take: 1 },
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
    : [];
  const supersededExistingByKey = new Map(
    supersededExistingEvents.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      event,
    ]),
  );
  const supersededTargetKeys = [
    ...new Set(supersededMatches.map(({ targetEventKey }) => targetEventKey)),
  ];
  const supersededTargetEvents = supersededTargetKeys.length
    ? await db.event.findMany({
        where: { sourceKey: { in: supersededTargetKeys } },
        select: { id: true, sourceKey: true },
      })
    : [];
  const supersededTargetByKey = new Map(
    supersededTargetEvents.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      event,
    ]),
  );
  const removableSupersededEvents =
    /** @type {Array<{match: Record<string, any>, existing: Record<string, any>, target: Record<string, any> | undefined}>} */ ([]);
  const protectedSupersededEvents =
    /** @type {Array<{sourceEventKey: string, targetEventKey: string, reason: string}>} */ ([]);
  for (const match of supersededMatches) {
    const existing = supersededExistingByKey.get(match.sourceEventKey);
    if (!existing) continue;
    const target = supersededTargetByKey.get(match.targetEventKey);
    const isUnreviewedProjection =
      existing.status === "PROJECTED" &&
      !existing.curation &&
      !existing.globalBaseline &&
      !existing.dateEvidence?.length &&
      !existing.globalCandidates?.length &&
      !existing.reviews?.length &&
      !existing.family?.artworkReviewedAt &&
      (existing.rewardSources ?? []).every(
        (/** @type {Record<string, any>} */ source) =>
          source.status === "PROJECTED" &&
          (source.rewards ?? []).every(
            (/** @type {Record<string, any>} */ reward) =>
              !reward.reviewedAt &&
              !reward.curation &&
              !reward.reviews?.length &&
              !reward.globalBaseline,
          ),
      );
    const targetIsAvailable = Boolean(target) || Boolean(options.dryRun);
    if (targetIsAvailable && isUnreviewedProjection) {
      removableSupersededEvents.push({ match, existing, target });
    } else {
      protectedSupersededEvents.push({
        sourceEventKey: match.sourceEventKey,
        targetEventKey: match.targetEventKey,
        reason: targetIsAvailable
          ? "REVIEWED_OR_NON_PROJECTED"
          : "MISSING_ATLAS_TARGET",
      });
    }
  }

  const rewardsByEvent = new Map();
  for (const source of dataset.rewardSources) {
    const eventKey = source.eventSourceKey ?? source.externalEventSourceKey;
    if (!eventKey || missingExternalKeys.includes(eventKey)) continue;
    const values = rewardsByEvent.get(eventKey) ?? [];
    values.push(source);
    rewardsByEvent.set(eventKey, values);
  }
  const existingByKey = new Map(
    existingEvents.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      event,
    ]),
  );
  const maintainedExistingEvents = [
    ...plan.updates,
    ...plan.unchangedMutable,
    ...plan.unchangedFrozen,
    ...plan.frozenDifferences,
  ]
    .filter((candidate) => new Date(candidate.endsAt) >= options.asOf)
    .map(({ sourceKey }) => existingByKey.get(sourceKey))
    .filter(Boolean);
  const obsoleteRewardSources = [
    ...maintainedExistingEvents,
    ...externalEvents,
  ].reduce(
    (count, event) =>
      count +
      obsoleteManagedRewardSourceIds(
        event,
        rewardsByEvent.get(event.sourceKey) ?? [],
      ).length,
    0,
  );
  const frozenKeys = new Set(
    [...plan.unchangedFrozen, ...plan.frozenDifferences].map(
      ({ sourceKey }) => sourceKey,
    ),
  );
  const rewardChangeBreakdown = [
    ...maintainedExistingEvents,
    ...externalEvents,
  ].reduce((changes, event) => {
    const desired = rewardsByEvent.get(event.sourceKey) ?? [];
    const eventChanges = eventRewardChangeBreakdown(event, desired, {
      insertMissingOnly: frozenKeys.has(event.sourceKey),
      obsoleteSourceIds: obsoleteManagedRewardSourceIds(event, desired),
    });
    for (const [key, count] of Object.entries(eventChanges))
      changes[key] = (changes[key] ?? 0) + count;
    return changes;
  }, /** @type {Record<string, number>} */ ({ dateBasisOnly: 0, rewardUpdates: 0, newRewards: 0, sourceUpdates: 0, removedRecords: 0 }));
  const rewardChanges = Object.values(rewardChangeBreakdown).reduce(
    (total, count) => total + count,
    0,
  );
  const limits = checkReconciliationLimits({
    eventChanges: plan.updates.length + removableSupersededEvents.length,
    rewardChanges,
    maxUpdates,
    maxRewardChanges: options.maxRewardChanges ?? 250,
    dryRun: options.dryRun,
  });
  const rewardDefinitions = dataset.rewardSources.reduce(
    (count, source) => count + source.rewards.length,
    0,
  );
  const report = {
    ...limits,
    informationalIssues: countImportIssues(dataset.issues).informationalIssues,
    rewardChangeBreakdown,
    selected: dataset.events.length,
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    unchangedMutable: plan.unchangedMutable.length,
    frozenDifferences: plan.frozenDifferences.length,
    protectedDifferences: plan.protectedDifferences.length,
    missingSourceRecords: plan.missingSourceKeys.length,
    heldEvents: selected.heldEvents.length,
    missingExternalEvents: missingExternalKeys.length,
    obsoleteRewardSources,
    supersededEvents: removableSupersededEvents.length,
    protectedSupersededEvents: protectedSupersededEvents.length,
    rewardDefinitions,
    warnings:
      countImportIssues(dataset.issues).warnings +
      missingExternalKeys.length +
      protectedSupersededEvents.length,
    dryRun: Boolean(options.dryRun),
  };
  if (options.dryRun) return report;

  const syncRun = await db.syncRun.create({
    data: {
      source: FANDOM_SYNC_SOURCE,
      status: "RUNNING",
      dryRun: false,
      contentHash: dataset.events[0]?.sourceContentHash ?? null,
      fetchedCount: inputDataset.events.length,
      selectedCount: dataset.events.length,
    },
  });
  const families = new Map(
    dataset.families.map((family) => [family.sourceKey, family]),
  );
  const rewardEnrichmentCandidates = [
    ...plan.unchangedFrozen,
    ...plan.frozenDifferences,
  ].filter((candidate) => new Date(candidate.endsAt) >= options.asOf);

  try {
    await db.$transaction(
      async (/** @type {Record<string, any>} */ transaction) => {
        const metadataUpdates = new Map();
        const [lock] = await transaction.$queryRawUnsafe(
          `SELECT pg_try_advisory_xact_lock(${FANDOM_SYNC_ADVISORY_LOCK_ID}) AS acquired`,
        );
        if (!lock?.acquired) {
          throw new Error("Another Fandom event synchronisation is running.");
        }

        for (const candidate of [...plan.inserts, ...plan.updates]) {
          const family = families.get(candidate.familySourceKey);
          if (!family) {
            throw new Error(
              `Event ${candidate.sourceKey} has no event family.`,
            );
          }
          const existing = existingByKey.get(candidate.sourceKey);
          const savedFamily = await saveFamily(
            transaction,
            family,
            existing?.family,
          );
          const data = { ...eventData(candidate), familyId: savedFamily.id };
          const savedEvent = await transaction.event.upsert({
            where: { sourceKey: candidate.sourceKey },
            create: { sourceKey: candidate.sourceKey, ...data },
            update: data,
          });
          if (existing) {
            await removeObsoleteRewardSources(
              transaction,
              existing,
              rewardsByEvent.get(candidate.sourceKey) ?? [],
            );
          }
          for (const source of rewardsByEvent.get(candidate.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              savedEvent.id,
              existingRewardMap(existing),
              {
                metadataUpdates,
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
            );
          }
        }

        for (const candidate of plan.unchangedMutable) {
          const existing = existingByKey.get(candidate.sourceKey);
          if (!existing) continue;
          await transaction.event.update({
            where: { sourceKey: candidate.sourceKey },
            data: {
              lastSyncedAt: toDate(candidate.lastSyncedAt),
              sourceContentHash: candidate.sourceContentHash,
            },
          });
          await removeObsoleteRewardSources(
            transaction,
            existing,
            rewardsByEvent.get(candidate.sourceKey) ?? [],
          );
          for (const source of rewardsByEvent.get(candidate.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              existing.id,
              existingRewardMap(existing),
              {
                metadataUpdates,
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
            );
          }
        }

        for (const candidate of rewardEnrichmentCandidates) {
          const existing = existingByKey.get(candidate.sourceKey);
          if (!existing) continue;
          await removeObsoleteRewardSources(
            transaction,
            existing,
            rewardsByEvent.get(candidate.sourceKey) ?? [],
          );
          for (const source of rewardsByEvent.get(candidate.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              existing.id,
              existingRewardMap(existing),
              {
                metadataUpdates,
                insertMissingOnly: true,
                existingSource: existing?.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
            );
          }
        }

        for (const external of externalEvents) {
          await removeObsoleteRewardSources(
            transaction,
            external,
            rewardsByEvent.get(external.sourceKey) ?? [],
          );
          for (const source of rewardsByEvent.get(external.sourceKey) ?? []) {
            await saveRewardSource(
              transaction,
              source,
              external.id,
              existingRewardMap(external),
              {
                metadataUpdates,
                existingSource: external.rewardSources?.find(
                  (/** @type {Record<string, any>} */ value) =>
                    value.sourceKey === source.sourceKey,
                ),
              },
            );
          }
        }

        for (const [dateBasis, updates] of metadataUpdates) {
          for (
            let index = 0;
            index < updates.length;
            index += IMPORT_WRITE_LIMITS.rewardMetadataBatchSize
          ) {
            await transaction.rewardDefinition.updateMany({
              where: {
                OR: updates
                  .slice(
                    index,
                    index + IMPORT_WRITE_LIMITS.rewardMetadataBatchSize,
                  )
                  .map(
                    (
                      /** @type {{sourceKey: string, sourceSourceKey: string}} */ update,
                    ) => ({
                      sourceKey: update.sourceKey,
                      rewardSource: {
                        sourceKey: update.sourceSourceKey,
                        status: { notIn: ["CURATED", "OFFICIAL"] },
                      },
                    }),
                  ),
                dateBasis: { not: dateBasis },
              },
              data: { dateBasis },
            });
          }
        }

        for (const { existing } of removableSupersededEvents) {
          await transaction.rewardSource.deleteMany({
            where: { eventId: existing.id },
          });
          await transaction.event.delete({ where: { id: existing.id } });
        }

        await transaction.syncRun.update({
          where: { id: syncRun.id },
          data: {
            status: "SUCCEEDED",
            completedAt: new Date(),
            insertedCount: report.inserted,
            updatedCount: report.updated,
            frozenDifferenceCount: report.frozenDifferences,
            rewardCount: report.rewardDefinitions,
            omittedRewardCount: report.missingExternalEvents,
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
          errorMessage: safeSyncFailure(error),
        },
      });
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "Fandom event synchronisation failed and its failure could not be recorded.",
      );
    }
    throw error;
  }
}
