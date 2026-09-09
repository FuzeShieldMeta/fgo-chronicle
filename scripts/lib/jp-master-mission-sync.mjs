import { buildStoryCatalogue } from "./story-catalogue.mjs";
import { z } from "zod";
import { storyMissionRequirement } from "./story-mission-requirements.mjs";

import {
  combineTrackedRewards,
  trackedRewardGifts,
} from "./atlas-event-adapter.mjs";
import { ATLAS_TRACKED_REWARD_ITEM_IDS } from "./atlas-domain.mjs";
import { addCalendarYears } from "./jp-event-sync.mjs";

const giftSchema = z
  .object({
    id: z.number().int().optional(),
    type: z.string(),
    objectId: z.number().int(),
    num: z.number().int(),
  })
  .passthrough();

const missionSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.string().min(1),
    name: z.string().default(""),
    detail: z.string().optional(),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive(),
    gifts: z.array(giftSchema).default([]),
    conds: z.array(z.unknown()).default([]),
  })
  .passthrough()
  .refine(({ startedAt, endedAt }) => endedAt >= startedAt, {
    message: "A Master Mission cannot end before it starts.",
    path: ["endedAt"],
  });

const missionSetSchema = z
  .object({
    id: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive(),
    closedAt: z.number().int().positive(),
    missions: z.array(missionSchema).default([]),
  })
  .passthrough();

const exportSchema = z.array(missionSetSchema).min(1);

/** @param {unknown} value */
export function parseAtlasMasterMissionExport(value) {
  return exportSchema.parse(value);
}

/** @param {Date} value */
function unixSeconds(value) {
  return Math.floor(value.getTime() / 1_000);
}

/** @param {number} value */
function projectedIso(value) {
  return addCalendarYears(new Date(value * 1_000), 2).toISOString();
}

/** @param {unknown} value @param {string[]} [path] @param {string[]} [locations] */
function trackedGiftLocations(value, path = [], locations = []) {
  if (!value || typeof value !== "object") return locations;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      trackedGiftLocations(item, [...path, String(index)], locations),
    );
    return locations;
  }

  const record = /** @type {Record<string, any>} */ (value);
  if (
    record.type === "item" &&
    ATLAS_TRACKED_REWARD_ITEM_IDS.has(record.objectId) &&
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
function normalisedLocation(location) {
  return location
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .join(".");
}

/**
 * @param {any[]} missionSets
 * @param {{asOf: Date, retrievedAt: string, contentHash: string, rawWars?: Array<Record<string, any>>}} options
 */
export function buildProjectedMasterMissionDataset(missionSets, options) {
  const storyCatalogue = buildStoryCatalogue(options.rawWars ?? []);
  const sourceFrom = unixSeconds(addCalendarYears(options.asOf, -2));
  const sourceTo = unixSeconds(options.asOf);
  const allLocations = missionSets.flatMap((missionSet) =>
    trackedGiftLocations(missionSet),
  );
  const unknownLocations = allLocations.filter(
    (location) => normalisedLocation(location) !== "missions.gifts",
  );
  const evidenceSources = new Map([
    [
      "atlas:JP:mm-export",
      {
        sourceKey: "atlas:JP:mm-export",
        type: "ATLAS_ACADEMY",
        region: "JP",
        url: "https://api.atlasacademy.io/export/JP/nice_master_mission.json",
        retrievedAt: options.retrievedAt,
        contentHash: options.contentHash,
      },
    ],
  ]);
  const rewardSources = [];
  const issues = [];
  let selectedLimitedMissions = 0;
  let selectedPermanentMissions = 0;
  let omittedWeeklyMissions = 0;
  let omittedUnsupportedMissions = 0;

  for (const missionSet of missionSets) {
    const evidenceSourceKey = `atlas:JP:mm:${missionSet.id}`;
    const evidenceUrl = `https://api.atlasacademy.io/nice/JP/mm/${missionSet.id}`;
    for (const mission of missionSet.missions) {
      const rewards = combineTrackedRewards(trackedRewardGifts(mission.gifts));
      if (rewards.length === 0) continue;
      if (mission.startedAt < sourceFrom || mission.startedAt > sourceTo) {
        continue;
      }
      if (mission.type === "weekly") {
        omittedWeeklyMissions += 1;
        continue;
      }
      if (mission.type !== "limited" && mission.type !== "extra") {
        omittedUnsupportedMissions += 1;
        issues.push({
          sourceKey: `${evidenceSourceKey}:mission:${mission.id}:unsupported-type`,
          severity: "WARNING",
          message: `Master Mission ${mission.id} has tracked rewards under unsupported type ${mission.type}. It was held for review.`,
        });
        continue;
      }

      const story = storyMissionRequirement(
        mission,
        options.rawWars ?? [],
        storyCatalogue.chapters,
      );
      const isLimited = mission.type === "limited";
      if (isLimited) selectedLimitedMissions += 1;
      else selectedPermanentMissions += 1;
      evidenceSources.set(evidenceSourceKey, {
        sourceKey: evidenceSourceKey,
        type: "ATLAS_ACADEMY",
        region: "JP",
        url: evidenceUrl,
        retrievedAt: options.retrievedAt,
        contentHash: options.contentHash,
      });
      const sourceKey = `${evidenceSourceKey}:mission:${mission.id}:projection:NA`;
      const missionName = mission.name.trim() || `Master Mission ${mission.id}`;
      const expectedAt = projectedIso(
        isLimited ? mission.endedAt : mission.startedAt,
      );
      rewardSources.push({
        sourceKey,
        eventSourceKey: null,
        externalEventSourceKey: null,
        evidenceSourceKey,
        name: missionName,
        type: "MASTER_MISSION",
        status: "PROJECTED",
        evidenceUrl,
        lastVerifiedAt: options.retrievedAt,
        sourceStartsAt: projectedIso(mission.startedAt),
        rewards: rewards.map((reward) => ({
          sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
          itemType: reward.itemType,
          amount: reward.amount,
          expectedAt,
          nature: "CONDITIONAL",
          eligibility: mission.detail?.trim() || missionName,
          storyWarId: story?.warId ?? null,
          storyReleaseAt: story ? projectedIso(mission.startedAt) : null,
          defaultIncluded: isLimited,
          reviewedAt: null,
        })),
      });
    }
  }

  if (unknownLocations.length > 0) {
    issues.push({
      sourceKey: "atlas:JP:mm:unknown-reward-structure:projection:NA",
      severity: "WARNING",
      message: `${unknownLocations.length} tracked Atlas Master Mission gift records use an unsupported structure. These rewards require review.`,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: options.retrievedAt,
    review: {
      status: "NEEDS_REVIEW",
      reviewedAt: null,
      note: "Automated Atlas Master Mission projection",
    },
    sources: [...evidenceSources.values()],
    families: [],
    events: [],
    rewardSources,
    issues,
    stats: {
      fetchedSets: missionSets.length,
      trackedGiftLocations: allLocations.length,
      unknownGiftLocations: unknownLocations.length,
      selectedLimitedMissions,
      selectedPermanentMissions,
      omittedWeeklyMissions,
      omittedUnsupportedMissions,
      rewardDefinitions: rewardSources.reduce(
        (count, source) => count + source.rewards.length,
        0,
      ),
    },
  };
}
