import { parseEventDataset } from "./event-dataset.mjs";

export const JP_MASTER_MISSION_SYNC_SOURCE = "ATLAS_JP_MASTER_MISSION_EXPORT";
const ADVISORY_LOCK_ID = 734621907;

/** @param {string | null | undefined} value */
function toDate(value) {
  return value ? new Date(value) : null;
}

/** @param {Record<string, any>} reward */
function rewardSignature(reward) {
  return JSON.stringify({
    itemType: reward.itemType,
    amount: reward.amount,
    expectedAt: toDate(reward.expectedAt)?.toISOString() ?? null,
    nature: reward.nature,
    eligibility: reward.eligibility ?? null,
    storyWarId: reward.storyWarId ?? null,
    storyReleaseAt: toDate(reward.storyReleaseAt)?.toISOString() ?? null,
    defaultIncluded: reward.defaultIncluded,
  });
}

/** @param {Record<string, any>} source */
function sourceSignature(source) {
  return JSON.stringify({
    name: source.name,
    type: source.type,
    status: source.status,
    evidenceUrl: source.evidenceUrl,
    rewards: [...source.rewards]
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
      .map((reward) => [reward.sourceKey, rewardSignature(reward)]),
  });
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
    storyWarId: reward.storyWarId ?? null,
    storyReleaseAt: toDate(reward.storyReleaseAt),
    defaultIncluded: reward.defaultIncluded,
    reviewedAt: toDate(reward.reviewedAt),
  };
}

/**
 * Append or refresh current projected Master Mission rewards. Records that
 * disappear from the rolling Atlas export remain in the ledger.
 * @param {Record<string, any>} db
 * @param {Record<string, any>} inputDataset
 * @param {{dryRun?: boolean, maxUpdates?: number, maxAssociationUpdates?: number, eventAssociations?: Array<{rewardSourceKey: string, eventSourceKey: string}>, ambiguousRewardSourceKeys?: string[]}} options
 */
export async function reconcileProjectedMasterMissions(
  db,
  inputDataset,
  options = {},
) {
  const dataset = parseEventDataset(inputDataset);
  const eventAssociations = options.eventAssociations ?? [];
  const ambiguousKeys = new Set(options.ambiguousRewardSourceKeys ?? []);
  const associationBySourceKey = new Map();
  for (const association of eventAssociations) {
    if (ambiguousKeys.has(association.rewardSourceKey)) {
      throw new Error(
        `Master Mission ${association.rewardSourceKey} has both a unique and an ambiguous association.`,
      );
    }
    const current = associationBySourceKey.get(association.rewardSourceKey);
    if (current && current !== association.eventSourceKey) {
      throw new Error(
        `Master Mission ${association.rewardSourceKey} has more than one event association.`,
      );
    }
    associationBySourceKey.set(
      association.rewardSourceKey,
      association.eventSourceKey,
    );
  }
  const targetSourceKeys = [...new Set(associationBySourceKey.values())];
  const targetEvents = targetSourceKeys.length
    ? await db.event.findMany({
        where: { sourceKey: { in: targetSourceKeys } },
        select: { id: true, sourceKey: true },
      })
    : [];
  const targetBySourceKey = new Map(
    targetEvents.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      event,
    ]),
  );
  const missingAssociationTargets = targetSourceKeys.filter(
    (sourceKey) => !targetBySourceKey.has(sourceKey),
  );
  const existingSources = await db.rewardSource.findMany({
    where: { sourceKey: { startsWith: "atlas:JP:mm:" } },
    include: { rewards: { include: { curation: true } } },
  });
  const existingByKey = new Map(
    existingSources.map((/** @type {Record<string, any>} */ source) => [
      source.sourceKey,
      source,
    ]),
  );
  const inserts = /** @type {Array<Record<string, any>>} */ ([]);
  const updates = /** @type {Array<Record<string, any>>} */ ([]);
  const protectedDifferences = /** @type {Array<Record<string, any>>} */ ([]);
  const associationUpdateKeys = new Set();
  const contentUpdateKeys = new Set();
  const obsoleteRewardKeys = new Map();
  let protectedRewardDifferences = 0;
  let protectedAssociationDifferences = 0;
  let unchanged = 0;

  for (const source of dataset.rewardSources) {
    const existing = existingByKey.get(source.sourceKey);
    const targetSourceKey = associationBySourceKey.get(source.sourceKey);
    const targetEvent = targetSourceKey
      ? targetBySourceKey.get(targetSourceKey)
      : null;
    const associationChanged = Boolean(
      existing &&
      (targetEvent || ambiguousKeys.has(source.sourceKey)) &&
      (existing.eventId ?? null) !== (targetEvent?.id ?? null),
    );
    if (!existing) {
      inserts.push(source);
    } else {
      const desiredRewards = new Map(
        source.rewards.map((reward) => [reward.sourceKey, reward]),
      );
      const reviewedRewards = existing.rewards.filter(
        (/** @type {Record<string, any>} */ reward) => reward.reviewedAt,
      );
      protectedRewardDifferences += reviewedRewards.filter(
        (/** @type {Record<string, any>} */ reward) => {
          const desired = desiredRewards.get(reward.sourceKey);
          return (
            !desired || rewardSignature(desired) !== rewardSignature(reward)
          );
        },
      ).length;
      const reviewedKeys = new Set(
        reviewedRewards.map(
          (/** @type {Record<string, any>} */ reward) => reward.sourceKey,
        ),
      );
      const retainedCuratorRewards = existing.rewards.filter(
        (/** @type {Record<string, any>} */ reward) =>
          !reward.reviewedAt &&
          reward.curation &&
          !desiredRewards.has(reward.sourceKey),
      );
      protectedRewardDifferences += retainedCuratorRewards.length;
      const effectiveSource = {
        ...source,
        rewards: [
          ...source.rewards.filter(
            (reward) => !reviewedKeys.has(reward.sourceKey),
          ),
          ...reviewedRewards,
          ...retainedCuratorRewards,
        ],
      };
      const contentChanged =
        sourceSignature(effectiveSource) !== sourceSignature(existing);
      if (existing.status === "PROJECTED") {
        obsoleteRewardKeys.set(
          source.sourceKey,
          existing.rewards
            .filter(
              (/** @type {Record<string, any>} */ reward) =>
                !reward.reviewedAt &&
                !reward.curation &&
                !desiredRewards.has(reward.sourceKey),
            )
            .map(
              (/** @type {Record<string, any>} */ reward) => reward.sourceKey,
            ),
        );
      }
      if (existing.status !== "PROJECTED") {
        if (contentChanged) protectedDifferences.push(source);
        if (associationChanged) protectedAssociationDifferences += 1;
        if (!contentChanged && !associationChanged) unchanged += 1;
      } else if (contentChanged || associationChanged) {
        updates.push(source);
        if (contentChanged) contentUpdateKeys.add(source.sourceKey);
        if (associationChanged) associationUpdateKeys.add(source.sourceKey);
      } else {
        unchanged += 1;
      }
    }
  }

  const maxUpdates = options.maxUpdates ?? 25;
  const contentUpdates = contentUpdateKeys.size;
  const updateLimitExceeded = contentUpdates > maxUpdates;
  if (updateLimitExceeded && !options.dryRun) {
    throw new Error(
      `The Master Mission sync proposed ${contentUpdates} content update${contentUpdates === 1 ? "" : "s"}. The limit is ${maxUpdates}. Inspect a dry run before you raise the limit.`,
    );
  }
  const maxAssociationUpdates = options.maxAssociationUpdates ?? 50;
  const associationLimitExceeded =
    associationUpdateKeys.size > maxAssociationUpdates;
  if (associationLimitExceeded && !options.dryRun) {
    throw new Error(
      `The Master Mission sync proposed ${associationUpdateKeys.size} event association update${associationUpdateKeys.size === 1 ? "" : "s"}. The limit is ${maxAssociationUpdates}. Inspect a dry run before you raise the limit.`,
    );
  }
  const report = {
    ...inputDataset.stats,
    inserted: inserts.length,
    updated: updates.length,
    contentUpdates,
    unchanged,
    protectedDifferences: protectedDifferences.length,
    associatedRewardSources: [...associationBySourceKey].filter(
      ([sourceKey, eventSourceKey]) =>
        dataset.rewardSources.some(
          (source) => source.sourceKey === sourceKey,
        ) && targetBySourceKey.has(eventSourceKey),
    ).length,
    associationUpdates: associationUpdateKeys.size,
    missingAssociationTargets: missingAssociationTargets.length,
    protectedAssociationDifferences,
    protectedRewardDifferences,
    obsoleteRewardDefinitions: [...obsoleteRewardKeys.values()].reduce(
      (count, keys) => count + keys.length,
      0,
    ),
    updateLimit: maxUpdates,
    updateLimitExceeded,
    associationUpdateLimit: maxAssociationUpdates,
    associationLimitExceeded,
    warnings:
      dataset.issues.length +
      protectedDifferences.length +
      missingAssociationTargets.length +
      protectedAssociationDifferences +
      protectedRewardDifferences,
    dryRun: Boolean(options.dryRun),
  };
  if (options.dryRun) return report;

  const syncRun = await db.syncRun.create({
    data: {
      source: JP_MASTER_MISSION_SYNC_SOURCE,
      status: "RUNNING",
      dryRun: false,
      contentHash: dataset.sources[0]?.contentHash ?? null,
      fetchedCount: inputDataset.stats?.fetchedSets ?? 0,
      selectedCount: dataset.rewardSources.length,
    },
  });

  try {
    await db.$transaction(
      async (/** @type {Record<string, any>} */ transaction) => {
        const [lock] = await transaction.$queryRawUnsafe(
          `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_ID}) AS acquired`,
        );
        if (!lock?.acquired) {
          throw new Error(
            "Another JP Master Mission synchronisation is running.",
          );
        }

        for (const source of [...inserts, ...updates]) {
          const existing = existingByKey.get(source.sourceKey);
          const targetSourceKey = associationBySourceKey.get(source.sourceKey);
          const targetEvent = targetSourceKey
            ? targetBySourceKey.get(targetSourceKey)
            : null;
          const savedSource = await transaction.rewardSource.upsert({
            where: { sourceKey: source.sourceKey },
            create: {
              sourceKey: source.sourceKey,
              eventId: targetEvent?.id ?? null,
              name: source.name,
              type: source.type,
              status: source.status,
              evidenceUrl: source.evidenceUrl,
              lastVerifiedAt: toDate(source.lastVerifiedAt),
            },
            update: {
              name: source.name,
              type: source.type,
              status: source.status,
              evidenceUrl: source.evidenceUrl,
              lastVerifiedAt: toDate(source.lastVerifiedAt),
              ...(targetEvent || ambiguousKeys.has(source.sourceKey)
                ? { eventId: targetEvent?.id ?? null }
                : {}),
            },
          });
          if (existing && !contentUpdateKeys.has(source.sourceKey)) continue;
          const obsoleteKeys = obsoleteRewardKeys.get(source.sourceKey) ?? [];
          if (obsoleteKeys.length > 0) {
            await transaction.rewardDefinition.deleteMany({
              where: {
                rewardSourceId: savedSource.id,
                sourceKey: { in: obsoleteKeys },
                reviewedAt: null,
                curation: { is: null },
              },
            });
          }
          const existingRewards = new Map(
            (existing?.rewards ?? []).map(
              (/** @type {Record<string, any>} */ reward) => [
                reward.sourceKey,
                reward,
              ],
            ),
          );
          for (const reward of source.rewards) {
            if (existingRewards.get(reward.sourceKey)?.reviewedAt) continue;
            const data = rewardData(reward, savedSource.id);
            await transaction.rewardDefinition.upsert({
              where: { sourceKey: reward.sourceKey },
              create: { sourceKey: reward.sourceKey, ...data },
              update: data,
            });
          }
        }

        await transaction.syncRun.update({
          where: { id: syncRun.id },
          data: {
            status: "SUCCEEDED",
            completedAt: new Date(),
            insertedCount: report.inserted,
            updatedCount: report.updated,
            rewardCount: inputDataset.stats?.rewardDefinitions ?? 0,
            omittedRewardCount:
              (inputDataset.stats?.omittedWeeklyMissions ?? 0) +
              (inputDataset.stats?.omittedUnsupportedMissions ?? 0),
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
          errorMessage: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 2_000),
        },
      });
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "JP Master Mission synchronisation failed and its failure could not be recorded.",
      );
    }
    throw error;
  }
}
