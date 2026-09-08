import {
  ATLAS_MANA_PRISM_ITEM_ID,
  ATLAS_TRACKED_REWARD_ITEMS,
} from "./atlas-domain.mjs";

/** @typedef {Record<string, any>} AtlasRecord */
/** @typedef {{region: string, retrievedAt: string, contentHash: string | null, family: {sourceKey: string, name: string}}} AtlasAdapterOptions */

/** @param {number} value */
function isoFromUnix(value) {
  return value ? new Date(value * 1000).toISOString() : null;
}

/** @param {AtlasRecord[]} gifts */
export function trackedRewardGifts(gifts = []) {
  return gifts.flatMap((gift) => {
    const itemType =
      gift.type === "item" && ATLAS_TRACKED_REWARD_ITEMS.get(gift.objectId);
    if (!itemType || !Number.isInteger(gift.num) || gift.num <= 0) return [];
    return [
      {
        itemType,
        amount: gift.num,
        sourceGiftKey: Number.isInteger(gift.id)
          ? `${gift.id}:${gift.objectId}`
          : null,
      },
    ];
  });
}

/** @param {Array<{itemType: string, amount: number}>} rewards */
export function combineTrackedRewards(rewards) {
  const totals = new Map();
  for (const reward of rewards) {
    totals.set(
      reward.itemType,
      (totals.get(reward.itemType) ?? 0) + reward.amount,
    );
  }
  return [...totals].map(([itemType, amount]) => ({ itemType, amount }));
}

/** @param {Array<{itemType: string, amount: number}>} rewards */
function rewardSignature(rewards) {
  return combineTrackedRewards(rewards)
    .sort((left, right) => left.itemType.localeCompare(right.itemType))
    .map(({ itemType, amount }) => `${itemType}:${amount}`)
    .join("|");
}

/**
 * Find every tracked Atlas gift object so a new nesting location cannot be
 * silently omitted by the scheduled import.
 * @param {unknown} value
 * @param {string[]} [path]
 * @param {string[]} [locations]
 */
function trackedGiftLocations(value, path = [], locations = []) {
  if (!value || typeof value !== "object") return locations;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      trackedGiftLocations(item, [...path, String(index)], locations),
    );
    return locations;
  }

  const record = /** @type {AtlasRecord} */ (value);
  if (
    record.type === "item" &&
    ATLAS_TRACKED_REWARD_ITEMS.has(record.objectId) &&
    Number.isInteger(record.num) &&
    record.num > 0
  ) {
    locations.push(path.join("."));
  }
  for (const [key, child] of Object.entries(record)) {
    trackedGiftLocations(child, [...path, key], locations);
  }
  return locations;
}

/** @param {string} location */
function classifyTrackedGiftLocation(location) {
  const shape = location
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .join(".");
  if (shape === "spots.quests.gifts") return "QUEST_GIFT";
  if (shape === "spots.quests.presents.gifts") return "QUEST_PRESENT";
  if (shape === "questSelections.quest.gifts") return "QUEST_SELECTION";
  if (shape === "questSelections.quest.presents.gifts") {
    return "QUEST_SELECTION_PRESENT";
  }
  if (
    shape === "spots.quests.gifts.giftAdds.replacementGifts" ||
    shape === "questSelections.quest.gifts.giftAdds.replacementGifts"
  ) {
    return "REPLACEMENT_GIFT";
  }
  return "UNKNOWN";
}

/** @param {string} location */
function classifyTrackedEventGiftLocation(location) {
  const shape = location
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .join(".");
  if (shape === "rewards.gifts") return "POINT_REWARD";
  if (shape === "missions.gifts") return "MISSION_REWARD";
  if (shape === "shop.gifts") return "SHOP_GIFT";
  if (shape === "lotteries.boxes.gifts") return "LOTTERY_REWARD";
  return "UNKNOWN";
}

/**
 * @param {AtlasRecord} quest
 * @param {string} sourceKeyPrefix
 * @param {string} evidenceSourceKey
 * @param {string} evidenceUrl
 * @param {boolean} defaultIncluded
 */
function extractQuestPresentRewards(
  quest,
  sourceKeyPrefix,
  evidenceSourceKey,
  evidenceUrl,
  defaultIncluded,
) {
  const questName = quest.name || `Quest ${quest.id}`;
  return /** @type {AtlasRecord[]} */ (quest.presents ?? []).flatMap(
    (present, index) => {
      const rewards = combineTrackedRewards(trackedRewardGifts(present.gifts));
      if (rewards.length === 0) return [];

      const phase = Number.isInteger(present.phase) ? present.phase : index + 1;
      const sourceKey = `${sourceKeyPrefix}:quest:${quest.id}:present:${phase}:${index}`;
      const phaseLabel = Number.isInteger(present.phase)
        ? ` phase ${present.phase}`
        : "";
      const hasAdditionalCondition =
        typeof present.condType === "string" && present.condType !== "none";
      const condition = hasAdditionalCondition
        ? ` Atlas condition: ${present.condType} (${present.condId ?? 0}, ${present.condNum ?? 0}).`
        : "";
      return [
        {
          sourceKey,
          evidenceSourceKey,
          name: `${questName}${phaseLabel} reward`,
          type: "QUEST_CLEAR",
          status: "CURATED",
          evidenceUrl,
          lastVerifiedAt: null,
          rewards: rewards.map((reward) => ({
            ...rewardDefinition(
              sourceKey,
              reward,
              `Clear${phaseLabel} of ${questName}.${condition}`,
              isoFromUnix(quest.openedAt),
            ),
            defaultIncluded: hasAdditionalCondition ? false : defaultIncluded,
          })),
        },
      ];
    },
  );
}

/**
 * Atlas gift additions can replace a base reward when a prior quest has
 * already been cleared. Do not add both sides of that alternative.
 * @param {AtlasRecord[]} quests
 * @param {string} sourceKeyPrefix
 */
function replacementRewardIssues(quests, sourceKeyPrefix) {
  const issues = [];
  for (const quest of quests) {
    const baseSignature = rewardSignature(trackedRewardGifts(quest.gifts));
    const seen = new Set();
    for (const gift of /** @type {AtlasRecord[]} */ (quest.gifts ?? [])) {
      for (const addition of /** @type {AtlasRecord[]} */ (
        gift.giftAdds ?? []
      )) {
        const replacementSignature = rewardSignature(
          trackedRewardGifts(addition.replacementGifts),
        );
        const signature = `${addition.priority ?? 0}:${addition.condType ?? "unknown"}:${replacementSignature}`;
        if (seen.has(signature) || replacementSignature === baseSignature) {
          continue;
        }
        seen.add(signature);
        issues.push({
          sourceKey: `${sourceKeyPrefix}:quest:${quest.id}:replacement:${addition.priority ?? 0}`,
          severity: "WARNING",
          message: `${quest.name || `Quest ${quest.id}`} has an alternate reward for ${addition.condType ?? "an unknown condition"}. The base reward was imported; the replacement requires review.`,
        });
      }
    }
  }
  return issues;
}

/**
 * @param {AtlasRecord[]} quests
 * @param {string} sourceKeyPrefix
 */
function conditionalPresentIssues(quests, sourceKeyPrefix) {
  return quests.flatMap((quest) =>
    /** @type {AtlasRecord[]} */ (quest.presents ?? []).flatMap(
      (present, index) => {
        if (
          !trackedRewardGifts(present.gifts).length ||
          !present.condType ||
          present.condType === "none"
        ) {
          return [];
        }
        return [
          {
            sourceKey: `${sourceKeyPrefix}:quest:${quest.id}:present:${present.phase ?? index + 1}:condition-review`,
            severity: "WARNING",
            message: `${quest.name || `Quest ${quest.id}`} has a phase reward controlled by Atlas condition ${present.condType}. It defaults to excluded until reviewed.`,
          },
        ];
      },
    ),
  );
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
  const rewardSources = [];
  const issues = [];
  for (const shop of shops) {
    const directGifts = trackedRewardGifts(shop.gifts);
    const trackedTargetIds = /** @type {number[]} */ (
      shop.targetIds ?? []
    ).filter((targetId) => ATLAS_TRACKED_REWARD_ITEMS.has(targetId));
    const hasSafeLimit =
      Number.isSafeInteger(shop.setNum) &&
      shop.setNum > 0 &&
      Number.isSafeInteger(shop.limitNum) &&
      shop.limitNum > 0;
    if (trackedTargetIds.length > 0 && shop.purchaseType !== "item") {
      issues.push({
        sourceKey: `${evidenceSourceKey}:shop:${shop.id}:purchase-type`,
        severity: "WARNING",
        message: `${shop.name || `Event shop item ${shop.id}`} has a tracked target under unsupported purchase type ${shop.purchaseType}. No target reward was generated.`,
      });
    } else if (trackedTargetIds.length > 0 && !hasSafeLimit) {
      issues.push({
        sourceKey: `${evidenceSourceKey}:shop:${shop.id}:invalid-limit`,
        severity: "WARNING",
        message: `${shop.name || `Event shop item ${shop.id}`} has no safe finite exchange quantity. No target reward was generated.`,
      });
    }
    const targetRewards =
      shop.purchaseType === "item" && hasSafeLimit
        ? trackedTargetIds.flatMap((targetId) => {
            const itemType = ATLAS_TRACKED_REWARD_ITEMS.get(targetId);
            if (!itemType) return [];
            return [
              {
                itemType,
                amount: shop.setNum * shop.limitNum,
              },
            ];
          })
        : [];
    const rewards = [...directGifts, ...targetRewards];
    if (rewards.length === 0) continue;

    const sourceKey = `atlas:${raw.id}:shop:${shop.id}`;
    const costItemName = shop.cost?.item?.name;
    const isManaPrismExchange =
      shop.cost?.item?.id === ATLAS_MANA_PRISM_ITEM_ID ||
      (typeof costItemName === "string" && /mana prism/i.test(costItemName));
    const cost = costItemName
      ? ` Each exchange costs ${shop.cost.amount} ${costItemName}.`
      : "";
    rewardSources.push({
      sourceKey,
      eventSourceKey,
      evidenceSourceKey,
      name: shop.name || `Event shop item ${shop.id}`,
      type: isManaPrismExchange ? "MANA_PRISM_EXCHANGE" : "EVENT_SHOP",
      status: "CURATED",
      evidenceUrl: url,
      lastVerifiedAt: null,
      rewards: combineTrackedRewards(rewards).map((reward) =>
        rewardDefinition(
          sourceKey,
          reward,
          `Purchase the item from the event shop.${cost}`,
          isoFromUnix(raw.endedAt),
        ),
      ),
    });
  }
  return { rewardSources, issues };
}

/**
 * Import fixed rewards from finite lottery boxes. The final box of an
 * unlimited lottery is repeatable and therefore has no finite total.
 * @param {AtlasRecord} raw
 * @param {string} eventSourceKey
 * @param {string} evidenceSourceKey
 * @param {string} url
 */
function extractLotteryRewards(raw, eventSourceKey, evidenceSourceKey, url) {
  const lotteries = /** @type {AtlasRecord[]} */ (raw.lotteries ?? []);
  const rewardSources = [];
  const issues = [];

  for (const lottery of lotteries) {
    const boxes = /** @type {AtlasRecord[]} */ (lottery.boxes ?? []);
    const boxIndexes = boxes
      .map(({ boxIndex }) => boxIndex)
      .filter(Number.isSafeInteger);
    const repeatableBoxIndex = lottery.limited ? null : Math.max(...boxIndexes);
    const grouped = new Map();

    for (const box of boxes) {
      const tracked = trackedRewardGifts(box.gifts);
      if (tracked.length === 0) continue;
      if (!Number.isSafeInteger(box.boxIndex) || box.boxIndex < 0) {
        issues.push({
          sourceKey: `${evidenceSourceKey}:lottery:${lottery.id}:invalid-box`,
          severity: "WARNING",
          message:
            "A lottery reward has no valid box number. No reward was generated.",
        });
        continue;
      }
      if (box.boxIndex === repeatableBoxIndex) {
        issues.push({
          sourceKey: `${evidenceSourceKey}:lottery:${lottery.id}:repeatable-box`,
          severity: "WARNING",
          message:
            "A tracked reward appears in a repeatable lottery box. No finite reward was generated.",
        });
        continue;
      }
      if (!Number.isSafeInteger(box.maxNum) || box.maxNum < 1) {
        issues.push({
          sourceKey: `${evidenceSourceKey}:lottery:${lottery.id}:box:${box.boxIndex}:invalid-limit`,
          severity: "WARNING",
          message: `Lottery box ${box.boxIndex + 1} has no valid item limit. No reward was generated.`,
        });
        continue;
      }
      const values = grouped.get(box.boxIndex) ?? [];
      values.push(
        ...tracked.map((reward) => ({
          ...reward,
          amount: reward.amount * box.maxNum,
        })),
      );
      grouped.set(box.boxIndex, values);
    }

    for (const [boxIndex, rewards] of grouped) {
      const boxNumber = boxIndex + 1;
      const sourceKey = `atlas:${raw.id}:lottery:${lottery.id}:box:${boxNumber}`;
      rewardSources.push({
        sourceKey,
        eventSourceKey,
        evidenceSourceKey,
        name: `Lottery box ${boxNumber}`,
        type: "LOTTERY",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: combineTrackedRewards(rewards).map((reward) =>
          rewardDefinition(
            sourceKey,
            reward,
            `Clear lottery box ${boxNumber}.`,
            isoFromUnix(raw.endedAt),
          ),
        ),
      });
    }
  }

  return { rewardSources, issues };
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
  const lottery = extractLotteryRewards(
    raw,
    eventSourceKey,
    evidenceSourceKey,
    url,
  );
  const shop = extractShopRewards(raw, eventSourceKey, evidenceSourceKey, url);
  const eventLocationCounts = /** @type {Record<string, number>} */ (
    Object.fromEntries(
      [
        "POINT_REWARD",
        "MISSION_REWARD",
        "SHOP_GIFT",
        "LOTTERY_REWARD",
        "UNKNOWN",
      ].map((key) => [key, 0]),
    )
  );
  for (const location of trackedGiftLocations(raw)) {
    const kind = classifyTrackedEventGiftLocation(location);
    eventLocationCounts[kind] = (eventLocationCounts[kind] ?? 0) + 1;
  }
  const structureIssues =
    (eventLocationCounts.UNKNOWN ?? 0) > 0
      ? [
          {
            sourceKey: `${evidenceSourceKey}:unknown-reward-structure`,
            severity: "WARNING",
            message: `${eventLocationCounts.UNKNOWN ?? 0} tracked Atlas gift records use an unsupported event structure. These rewards require review.`,
          },
        ]
      : [];
  const rewardSources = [
    ...extractPointRewards(raw, eventSourceKey, evidenceSourceKey, url),
    ...extractMissionRewards(raw, eventSourceKey, evidenceSourceKey, url),
    ...shop.rewardSources,
    ...lottery.rewardSources,
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
      artworkUrl:
        typeof raw.banner === "string" && raw.banner.trim()
          ? raw.banner.trim()
          : null,
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
      startsAtPrecision: "EXACT",
      endsAt: isoFromUnix(raw.endedAt),
      endsAtPrecision: "EXACT",
      status: "CURATED",
      sourceUrl: url,
      sourceRegion: options.region,
    },
    rewardSources,
    issues: [...shop.issues, ...lottery.issues, ...structureIssues],
    audit: {
      trackedGiftLocations: Object.values(eventLocationCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      pointRewardGiftLocations: eventLocationCounts.POINT_REWARD ?? 0,
      missionRewardGiftLocations: eventLocationCounts.MISSION_REWARD ?? 0,
      shopGiftLocations: eventLocationCounts.SHOP_GIFT ?? 0,
      lotteryRewardGiftLocations: eventLocationCounts.LOTTERY_REWARD ?? 0,
      trackedShopTargets: /** @type {AtlasRecord[]} */ (raw.shop ?? []).reduce(
        (count, shopEntry) =>
          count +
          /** @type {number[]} */ (shopEntry.targetIds ?? []).filter(
            (targetId) => ATLAS_TRACKED_REWARD_ITEMS.has(targetId),
          ).length,
        0,
      ),
      unknownGiftLocations: eventLocationCounts.UNKNOWN ?? 0,
    },
  };
}

/**
 * @param {AtlasRecord} raw
 * @param {{region: string, retrievedAt: string, contentHash: string | null, eventId: number, eventSourceKey: string, sourceKeyPrefix?: string, defaultIncluded?: boolean, eventStartsAt?: number, eventEndsAt?: number}} options
 */
export function normalizeAtlasWarRewards(raw, options) {
  if (!raw || !Number.isInteger(raw.id)) {
    throw new Error("Atlas war response is missing an integer id.");
  }

  const url = `https://api.atlasacademy.io/nice/${options.region}/war/${raw.id}`;
  const evidenceSourceKey = `atlas:${options.region}:war:${raw.id}`;
  const spots = /** @type {AtlasRecord[]} */ (raw.spots ?? []);
  const quests = spots
    .flatMap((spot) => /** @type {AtlasRecord[]} */ (spot.quests ?? []))
    .sort(
      (left, right) =>
        Number(left.flags?.includes("branch")) -
        Number(right.flags?.includes("branch")),
    );
  const sourceKeyPrefix = options.sourceKeyPrefix ?? `atlas:${options.eventId}`;
  const spotQuestIds = new Set(quests.map(({ id }) => id));
  const eventStartsAt = options.eventStartsAt;
  const eventEndsAt = options.eventEndsAt;
  const selectionQuests = /** @type {AtlasRecord[]} */ (
    raw.questSelections ?? []
  )
    .map(({ quest }) => quest)
    .filter(
      (quest) =>
        quest &&
        !spotQuestIds.has(quest.id) &&
        Number.isInteger(quest.openedAt) &&
        typeof eventStartsAt === "number" &&
        Number.isInteger(eventStartsAt) &&
        typeof eventEndsAt === "number" &&
        Number.isInteger(eventEndsAt) &&
        quest.openedAt >= eventStartsAt &&
        quest.openedAt <= eventEndsAt,
    );
  const seenQuestRewards = new Map();
  const spotRewardSources = quests.flatMap((quest) => {
    const questName = quest.name || `Quest ${quest.id}`;
    const isBranch = Boolean(quest.flags?.includes("branch"));
    const rewards = combineTrackedRewards(
      trackedRewardGifts(quest.gifts),
    ).filter((reward) => {
      const signature = `${questName}\u0000${reward.itemType}:${reward.amount}`;
      const existingIsBranch = seenQuestRewards.get(signature);
      if (existingIsBranch !== undefined && (existingIsBranch || isBranch)) {
        return false;
      }
      seenQuestRewards.set(signature, isBranch);
      return true;
    });
    if (rewards.length === 0) return [];

    const sourceKey = `${sourceKeyPrefix}:quest:${quest.id}`;
    const questLabel = `${quest.name ?? ""} ${quest.originalName ?? ""}`;
    const isChallenge = /challenge|高難易度/i.test(questLabel);
    return [
      {
        sourceKey,
        eventSourceKey: options.eventSourceKey,
        evidenceSourceKey,
        name: questName,
        type: isChallenge ? "CHALLENGE_QUEST" : "QUEST_CLEAR",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) => ({
          ...rewardDefinition(sourceKey, reward, `Clear ${questName}.`),
          defaultIncluded: options.defaultIncluded ?? true,
          expectedAt: isoFromUnix(quest.openedAt),
        })),
      },
    ];
  });
  const selectionRewardSources = selectionQuests.flatMap((quest) => {
    const questName = quest.name || `Quest ${quest.id}`;
    const rewards = combineTrackedRewards(trackedRewardGifts(quest.gifts));
    if (rewards.length === 0) return [];

    const sourceKey = `${sourceKeyPrefix}:quest-selection:${quest.id}`;
    const permanentQuest = new Set(["friendship", "rankup"]).has(quest.type);
    return [
      {
        sourceKey,
        eventSourceKey: options.eventSourceKey,
        evidenceSourceKey,
        name: questName,
        type: "QUEST_CLEAR",
        status: "CURATED",
        evidenceUrl: url,
        lastVerifiedAt: null,
        rewards: rewards.map((reward) => ({
          ...rewardDefinition(
            sourceKey,
            reward,
            `Clear ${questName}.`,
            isoFromUnix(quest.openedAt),
          ),
          defaultIncluded: permanentQuest
            ? false
            : (options.defaultIncluded ?? true),
        })),
      },
    ];
  });
  const presentRewardSources = [
    ...quests.flatMap((quest) =>
      extractQuestPresentRewards(
        quest,
        sourceKeyPrefix,
        evidenceSourceKey,
        url,
        options.defaultIncluded ?? true,
      ),
    ),
    ...selectionQuests.flatMap((quest) =>
      extractQuestPresentRewards(
        quest,
        `${sourceKeyPrefix}:selection`,
        evidenceSourceKey,
        url,
        new Set(["friendship", "rankup"]).has(quest.type)
          ? false
          : (options.defaultIncluded ?? true),
      ),
    ),
  ].map((source) => ({
    ...source,
    eventSourceKey: options.eventSourceKey,
  }));
  const rewardSources = [
    ...spotRewardSources,
    ...selectionRewardSources,
    ...presentRewardSources,
  ];

  const auditRaw = raw.sourceWarAudit ?? raw;
  const locationCounts = /** @type {Record<string, number>} */ (
    Object.fromEntries(
      [
        "QUEST_GIFT",
        "QUEST_PRESENT",
        "QUEST_SELECTION",
        "QUEST_SELECTION_PRESENT",
        "REPLACEMENT_GIFT",
        "UNKNOWN",
      ].map((key) => [key, 0]),
    )
  );
  for (const location of trackedGiftLocations(auditRaw)) {
    const kind = classifyTrackedGiftLocation(location);
    locationCounts[kind] = (locationCounts[kind] ?? 0) + 1;
  }
  const selectedGiftCount = selectionQuests.reduce(
    (count, quest) => count + trackedRewardGifts(quest.gifts).length,
    0,
  );
  const selectedSpotGiftCount = trackedGiftLocations({
    spots: raw.spots,
  }).filter((location) =>
    new Set(["QUEST_GIFT", "QUEST_PRESENT"]).has(
      classifyTrackedGiftLocation(location),
    ),
  ).length;
  const supportedQuests = [...quests, ...selectionQuests];
  const issues = [
    ...replacementRewardIssues(supportedQuests, sourceKeyPrefix),
    ...conditionalPresentIssues(supportedQuests, sourceKeyPrefix),
  ];
  if ((locationCounts.UNKNOWN ?? 0) > 0) {
    issues.push({
      sourceKey: `${sourceKeyPrefix}:unknown-reward-structure`,
      severity: "WARNING",
      message: `${locationCounts.UNKNOWN ?? 0} tracked Atlas gift records use an unsupported war structure. These rewards require review.`,
    });
  }

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
    issues,
    audit: {
      trackedGiftLocations: Object.values(locationCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      questGiftLocations: locationCounts.QUEST_GIFT ?? 0,
      questPresentLocations: locationCounts.QUEST_PRESENT ?? 0,
      eligibleSelectionGiftLocations: selectedGiftCount,
      ignoredSelectionGiftLocations:
        (locationCounts.QUEST_SELECTION ?? 0) - selectedGiftCount,
      ignoredSpotGiftLocations:
        (locationCounts.QUEST_GIFT ?? 0) +
        (locationCounts.QUEST_PRESENT ?? 0) -
        selectedSpotGiftCount,
      replacementGiftLocations: locationCounts.REPLACEMENT_GIFT ?? 0,
      unknownGiftLocations: locationCounts.UNKNOWN ?? 0,
    },
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
