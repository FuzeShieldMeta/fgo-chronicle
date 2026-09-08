import { addCalendarYears } from "./jp-event-sync.mjs";

/** @param {string | null | undefined} value */
function day(value) {
  return value?.slice(0, 10) ?? null;
}

/** @param {Record<string, any>} reward @param {string | null} campaignDay */
function clusterKey(reward, campaignDay) {
  return [
    campaignDay,
    day(reward.expectedAt),
    reward.itemType,
    reward.defaultIncluded,
  ].join("|");
}

/**
 * Atlas is the structured source for current Master Missions. Fandom remains
 * the historical fallback. Remove a Fandom mission cluster only when Atlas
 * covers the same campaign day, reward day, item, and inclusion rule with an
 * equal or greater amount.
 * @param {Record<string, any>} fandomDataset
 * @param {Record<string, any>} masterMissionDataset
 * @param {Array<Record<string, any>>} atlasEvents
 */
export function preferAtlasMasterMissions(
  fandomDataset,
  masterMissionDataset,
  atlasEvents,
) {
  const eventDays = new Map(
    fandomDataset.events.map((/** @type {Record<string, any>} */ event) => [
      event.sourceKey,
      day(event.startsAt),
    ]),
  );
  for (const event of atlasEvents) {
    eventDays.set(
      `atlas:JP:event:${event.id}:projection:NA`,
      day(addCalendarYears(new Date(event.startedAt * 1_000), 2).toISOString()),
    );
  }

  const atlasTotals = new Map();
  for (const source of masterMissionDataset.rewardSources) {
    const campaignDay = day(source.sourceStartsAt);
    for (const reward of source.rewards) {
      const key = clusterKey(reward, campaignDay);
      atlasTotals.set(key, (atlasTotals.get(key) ?? 0) + reward.amount);
    }
  }

  const fandomTotals = new Map();
  const fandomKeys = new Map();
  for (const source of fandomDataset.rewardSources) {
    if (source.type !== "MASTER_MISSION") continue;
    const eventKey = source.eventSourceKey ?? source.externalEventSourceKey;
    const campaignDay = eventKey ? (eventDays.get(eventKey) ?? null) : null;
    for (const reward of source.rewards) {
      const key = clusterKey(reward, campaignDay);
      fandomTotals.set(key, (fandomTotals.get(key) ?? 0) + reward.amount);
      const sourceKeys = fandomKeys.get(key) ?? new Set();
      sourceKeys.add(source.sourceKey);
      fandomKeys.set(key, sourceKeys);
    }
  }

  const replaceableClusters = new Set();
  const replaceableKeys = new Set();
  for (const [key, fandomAmount] of fandomTotals) {
    const atlasAmount = atlasTotals.get(key);
    if (atlasAmount !== undefined && atlasAmount >= fandomAmount) {
      replaceableClusters.add(key);
      for (const sourceKey of fandomKeys.get(key) ?? []) {
        replaceableKeys.add(sourceKey);
      }
    }
  }
  const suppressedSources = fandomDataset.rewardSources.filter(
    (/** @type {Record<string, any>} */ source) =>
      source.type === "MASTER_MISSION" &&
      replaceableKeys.has(source.sourceKey) &&
      source.rewards.every((/** @type {Record<string, any>} */ reward) => {
        const eventKey = source.eventSourceKey ?? source.externalEventSourceKey;
        const campaignDay = eventKey ? (eventDays.get(eventKey) ?? null) : null;
        return replaceableClusters.has(clusterKey(reward, campaignDay));
      }),
  );
  const suppressedKeys = new Set(
    suppressedSources.map(
      (/** @type {Record<string, any>} */ { sourceKey }) => sourceKey,
    ),
  );
  const fandomEventKeys = new Map();
  for (const source of suppressedSources) {
    const eventKey = source.eventSourceKey ?? source.externalEventSourceKey;
    if (!eventKey) continue;
    const campaignDay = eventDays.get(eventKey) ?? null;
    for (const reward of source.rewards) {
      const key = clusterKey(reward, campaignDay);
      const eventKeys = fandomEventKeys.get(key) ?? new Set();
      eventKeys.add(eventKey);
      fandomEventKeys.set(key, eventKeys);
    }
  }
  const masterMissionAssociations = [];
  const ambiguousRewardSourceKeys = [];
  for (const source of masterMissionDataset.rewardSources) {
    const campaignDay = day(source.sourceStartsAt);
    const matchedEventKeys = new Set();
    let matchedCluster = false;
    let ambiguous = false;
    for (const reward of source.rewards) {
      const key = clusterKey(reward, campaignDay);
      if (!replaceableClusters.has(key)) continue;
      matchedCluster = true;
      const eventKeys = fandomEventKeys.get(key) ?? new Set();
      if (eventKeys.size !== 1) {
        ambiguous = true;
        continue;
      }
      for (const eventKey of eventKeys) matchedEventKeys.add(eventKey);
    }
    if (!matchedCluster) continue;
    if (ambiguous || matchedEventKeys.size !== 1) {
      ambiguousRewardSourceKeys.push(source.sourceKey);
      continue;
    }
    masterMissionAssociations.push({
      rewardSourceKey: source.sourceKey,
      eventSourceKey: [...matchedEventKeys][0],
    });
  }

  return {
    dataset: {
      ...fandomDataset,
      rewardSources: fandomDataset.rewardSources.filter(
        (/** @type {Record<string, any>} */ { sourceKey }) =>
          !suppressedKeys.has(sourceKey),
      ),
    },
    masterMissionAssociations,
    ambiguousRewardSourceKeys,
    externalEventSourceKeys: [
      ...new Set(
        suppressedSources.flatMap(
          (/** @type {Record<string, any>} */ source) =>
            source.externalEventSourceKey &&
            !(fandomDataset.issues ?? []).some(
              (/** @type {Record<string, any>} */ issue) =>
                issue.severity === "ERROR" &&
                issue.sourceKey.startsWith(source.evidenceSourceKey),
            )
              ? [source.externalEventSourceKey]
              : [],
        ),
      ),
    ],
    report: {
      suppressedFandomRewardSources: suppressedSources.length,
      suppressedFandomRewardDefinitions: suppressedSources.reduce(
        (
          /** @type {number} */ count,
          /** @type {Record<string, any>} */ source,
        ) => count + source.rewards.length,
        0,
      ),
      associatedAtlasRewardSources: masterMissionAssociations.length,
      ambiguousAtlasRewardSources: ambiguousRewardSourceKeys.length,
    },
  };
}
