const REWARD_ITEMS = new Map([
  [2, "SAINT_QUARTZ"],
  [6, "SAINT_QUARTZ"],
  [11, "SAINT_QUARTZ_FRAGMENT"],
  [16, "SAINT_QUARTZ_FRAGMENT"],
  [4001, "SUMMON_TICKET"],
  [6999, "CRYSTALLIZED_LORE"],
  [7999, "HOLY_GRAIL"],
]);

/** @typedef {Record<string, any>} AtlasRecord */
/** @typedef {{region: string, retrievedAt: string, contentHash: string | null, family: {sourceKey: string, name: string}}} AtlasAdapterOptions */

/** @param {number} value */
function isoFromUnix(value) {
  return value ? new Date(value * 1000).toISOString() : null;
}

/** @param {AtlasRecord[]} gifts */
function trackedRewardGifts(gifts = []) {
  return gifts.flatMap((gift) => {
    const itemType = gift.type === "item" && REWARD_ITEMS.get(gift.objectId);
    if (!itemType || !Number.isInteger(gift.num) || gift.num <= 0) return [];
    return [{ itemType, amount: gift.num }];
  });
}

/**
 * @param {string} sourceKey
 * @param {{itemType: string, amount: number}} reward
 * @param {string} eligibility
 * @param {string | null} [expectedAt]
 */
function rewardDefinition(sourceKey, reward, eligibility, expectedAt = null) {
  return {
    sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
    itemType: reward.itemType,
    amount: reward.amount,
    expectedAt,
    nature: "CONDITIONAL",
    eligibility,
    defaultIncluded: true,
  };
}

/**
 * @param {AtlasRecord} raw
 * @param {string} eventSourceKey
 * @param {string} evidenceSourceKey
 * @param {string} url
 */
function extractPointRewards(raw, eventSourceKey, evidenceSourceKey, url) {
  const milestones = /** @type {AtlasRecord[]} */ (raw.rewards ?? []);
  return milestones.flatMap((milestone, index) => {
    const rewards = trackedRewardGifts(milestone.gifts);
    if (rewards.length === 0) return [];

    const sourceKey = `atlas:${raw.id}:point:${milestone.groupId ?? 0}:${milestone.point}:${index}`;
    return [
      {
        sourceKey,
        eventSourceKey,
        evidenceSourceKey,
        name: `${milestone.point.toLocaleString("en-US")} point reward`,
        type: "POINT_REWARD",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) =>
          rewardDefinition(
            sourceKey,
            reward,
            `Earn ${milestone.point.toLocaleString("en-US")} event points.`,
            isoFromUnix(raw.endedAt),
          ),
        ),
      },
    ];
  });
}

/**
 * @param {AtlasRecord} raw
 * @param {string} eventSourceKey
 * @param {string} evidenceSourceKey
 * @param {string} url
 */
function extractMissionRewards(raw, eventSourceKey, evidenceSourceKey, url) {
  const missions = /** @type {AtlasRecord[]} */ (raw.missions ?? []);
  return missions.flatMap((mission) => {
    const rewards = trackedRewardGifts(mission.gifts);
    if (rewards.length === 0) return [];

    const sourceKey = `atlas:${raw.id}:mission:${mission.id}`;
    const description = mission.dispNo
      ? `Complete event mission ${mission.dispNo}.`
      : `Complete the event mission: ${mission.name ?? mission.id}.`;
    return [
      {
        sourceKey,
        eventSourceKey,
        evidenceSourceKey,
        name: mission.name || `Event mission ${mission.id}`,
        type: "LIMITED_MISSION",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) =>
          rewardDefinition(
            sourceKey,
            reward,
            description,
            isoFromUnix(mission.endedAt ?? raw.endedAt),
          ),
        ),
      },
    ];
  });
}

/**
 * @param {AtlasRecord} raw
 * @param {string} eventSourceKey
 * @param {string} evidenceSourceKey
 * @param {string} url
 */
function extractShopRewards(raw, eventSourceKey, evidenceSourceKey, url) {
  const shops = /** @type {AtlasRecord[]} */ (raw.shop ?? []);
  return shops.flatMap((shop) => {
    const directGifts = trackedRewardGifts(shop.gifts);
    const targetRewards =
      shop.purchaseType === "item"
        ? /** @type {number[]} */ (shop.targetIds ?? []).flatMap((targetId) => {
            const itemType = REWARD_ITEMS.get(targetId);
            if (!itemType) return [];
            return [
              {
                itemType,
                amount: (shop.setNum || 1) * (shop.limitNum || 1),
              },
            ];
          })
        : [];
    const rewards = [...directGifts, ...targetRewards];
    if (rewards.length === 0) return [];

    const sourceKey = `atlas:${raw.id}:shop:${shop.id}`;
    const cost = shop.cost?.item?.name
      ? ` Spend ${shop.cost.amount} ${shop.cost.item.name}.`
      : "";
    return [
      {
        sourceKey,
        eventSourceKey,
        evidenceSourceKey,
        name: shop.name || `Event shop item ${shop.id}`,
        type: "EVENT_SHOP",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) =>
          rewardDefinition(
            sourceKey,
            reward,
            `Purchase the item from the event shop.${cost}`,
            isoFromUnix(raw.endedAt),
          ),
        ),
      },
    ];
  });
}

/** @param {AtlasRecord} raw */
function findLotteryTrackedRewards(raw) {
  const lotteries = /** @type {AtlasRecord[]} */ (raw.lotteries ?? []);
  return lotteries.flatMap((lottery) =>
    /** @type {AtlasRecord[]} */ (lottery.boxes ?? []).flatMap((box) =>
      trackedRewardGifts(box.gifts),
    ),
  );
}

/**
 * @param {AtlasRecord} raw
 * @param {AtlasAdapterOptions} options
 */
export function normalizeAtlasEvent(raw, options) {
  if (!raw || !Number.isInteger(raw.id) || !raw.name) {
    throw new Error("Atlas event response is missing an integer id or name.");
  }

  const url = `https://api.atlasacademy.io/nice/${options.region}/event/${raw.id}`;
  const evidenceSourceKey = `atlas:${options.region}:event:${raw.id}`;
  const eventSourceKey = `atlas:${options.region}:event:${raw.id}`;
  const lotteryRewards = findLotteryTrackedRewards(raw);
  const issues = [];

  if (lotteryRewards.length > 0) {
    issues.push({
      sourceKey: `${evidenceSourceKey}:lottery-review`,
      severity: "WARNING",
      message:
        "The lottery contains a tracked reward. Box limits and reset rules require manual review, so no reward was generated.",
    });
  }
  const rewardSources = [
    ...extractPointRewards(raw, eventSourceKey, evidenceSourceKey, url),
    ...extractMissionRewards(raw, eventSourceKey, evidenceSourceKey, url),
    ...extractShopRewards(raw, eventSourceKey, evidenceSourceKey, url),
  ];

  return {
    source: {
      sourceKey: evidenceSourceKey,
      type: "ATLAS_ACADEMY",
      region: options.region,
      url,
      retrievedAt: options.retrievedAt,
      contentHash: options.contentHash,
    },
    family: {
      sourceKey: options.family.sourceKey,
      name: options.family.name,
      artworkUrl: raw.noticeBanner || raw.banner || null,
      artworkSourceUrl: url,
      artworkAlt: `${options.family.name} event artwork`,
      artworkReviewedAt: null,
    },
    event: {
      sourceKey: eventSourceKey,
      familySourceKey: options.family.sourceKey,
      evidenceSourceKey,
      name: raw.name,
      type: "MAIN_EVENT",
      startsAt: isoFromUnix(raw.startedAt),
      endsAt: isoFromUnix(raw.endedAt),
      status: "CURATED",
      sourceUrl: url,
      sourceRegion: options.region,
    },
    rewardSources,
    issues,
  };
}

/**
 * @param {AtlasRecord} raw
 * @param {{region: string, retrievedAt: string, contentHash: string | null, eventId: number, eventSourceKey: string}} options
 */
export function normalizeAtlasWarRewards(raw, options) {
  if (!raw || !Number.isInteger(raw.id)) {
    throw new Error("Atlas war response is missing an integer id.");
  }

  const url = `https://api.atlasacademy.io/nice/${options.region}/war/${raw.id}`;
  const evidenceSourceKey = `atlas:${options.region}:war:${raw.id}`;
  const spots = /** @type {AtlasRecord[]} */ (raw.spots ?? []);
  const quests = spots.flatMap(
    (spot) => /** @type {AtlasRecord[]} */ (spot.quests ?? []),
  );
  const rewardSources = quests.flatMap((quest) => {
    const rewards = trackedRewardGifts(quest.gifts);
    if (rewards.length === 0) return [];

    const sourceKey = `atlas:${options.eventId}:quest:${quest.id}`;
    const isChallenge = /challenge/i.test(quest.name ?? "");
    return [
      {
        sourceKey,
        eventSourceKey: options.eventSourceKey,
        evidenceSourceKey,
        name: quest.name || `Quest ${quest.id}`,
        type: isChallenge ? "CHALLENGE_QUEST" : "QUEST_CLEAR",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) => ({
          ...rewardDefinition(
            sourceKey,
            reward,
            `Clear ${quest.name || `quest ${quest.id}`}.`,
          ),
          expectedAt: isoFromUnix(quest.openedAt),
        })),
      },
    ];
  });

  return {
    source: {
      sourceKey: evidenceSourceKey,
      type: "ATLAS_ACADEMY",
      region: options.region,
      url,
      retrievedAt: options.retrievedAt,
      contentHash: options.contentHash,
    },
    rewardSources,
    issues: [],
  };
}

/**
 * @param {AtlasRecord} raw
 * @param {{region: string, retrievedAt: string, contentHash: string | null}} options
 */
export function normalizeAtlasMasterMission(raw, options) {
  if (!raw || !Number.isInteger(raw.id)) {
    throw new Error("Atlas Master Mission response is missing an integer id.");
  }

  const url = `https://api.atlasacademy.io/nice/${options.region}/mm/${raw.id}`;
  const evidenceSourceKey = `atlas:${options.region}:mm:${raw.id}`;
  const missions = /** @type {AtlasRecord[]} */ (raw.missions ?? []);
  const rewardSources = missions.flatMap((mission) => {
    const rewards = trackedRewardGifts(mission.gifts);
    if (rewards.length === 0) return [];

    const sourceKey = `${evidenceSourceKey}:mission:${mission.id}`;
    const missionName =
      mission.name || `Master Mission ${mission.dispNo ?? mission.id}`;
    return [
      {
        sourceKey,
        eventSourceKey: null,
        evidenceSourceKey,
        name: missionName,
        type: "MASTER_MISSION",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: options.retrievedAt,
        rewards: rewards.map((reward) =>
          rewardDefinition(
            sourceKey,
            reward,
            `Complete: ${missionName}`,
            // Completion time varies by player. Credit forecast income no later
            // than the mission deadline instead of assuming an earlier claim.
            isoFromUnix(mission.endedAt ?? raw.endedAt),
          ),
        ),
      },
    ];
  });

  return {
    source: {
      sourceKey: evidenceSourceKey,
      type: "ATLAS_ACADEMY",
      region: options.region,
      url,
      retrievedAt: options.retrievedAt,
      contentHash: options.contentHash,
    },
    rewardSources,
    issues: [],
  };
}
