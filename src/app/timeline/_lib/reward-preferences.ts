import { z } from "zod";

export const rewardPreferencesSchema = z.object({
  version: z.literal(1),
  includedByRewardId: z.record(z.string().min(1), z.boolean()),
});

export type RewardPreferences = z.infer<typeof rewardPreferencesSchema>;

export const rewardPreferencesStorageKey =
  "fgo-chronicle:reward-preferences:v1";

export function createRewardPreferences(): RewardPreferences {
  return {
    version: 1,
    includedByRewardId: {},
  };
}

export function parseRewardPreferences(
  value: unknown,
): RewardPreferences | null {
  const result = rewardPreferencesSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function loadRewardPreferences(storage: Storage): RewardPreferences {
  try {
    const value = storage.getItem(rewardPreferencesStorageKey);
    if (!value) return createRewardPreferences();
    return (
      parseRewardPreferences(JSON.parse(value)) ?? createRewardPreferences()
    );
  } catch {
    return createRewardPreferences();
  }
}

export function saveRewardPreferences(
  storage: Storage,
  preferences: RewardPreferences,
) {
  storage.setItem(
    rewardPreferencesStorageKey,
    JSON.stringify(rewardPreferencesSchema.parse(preferences)),
  );
}

export function setRewardInclusion(
  preferences: RewardPreferences,
  rewardId: string,
  included: boolean,
): RewardPreferences {
  return {
    ...preferences,
    includedByRewardId: {
      ...preferences.includedByRewardId,
      [rewardId]: included,
    },
  };
}

export function resolveRewardInclusion(
  reward: { id: string; nature: string; defaultIncluded: boolean },
  preferences: RewardPreferences,
) {
  const hasPlayerDecision = Object.hasOwn(
    preferences.includedByRewardId,
    reward.id,
  );
  return {
    included: hasPlayerDecision
      ? (preferences.includedByRewardId[reward.id] ?? reward.defaultIncluded)
      : reward.defaultIncluded,
    inclusionResolved:
      reward.nature !== "CONDITIONAL" ||
      reward.defaultIncluded ||
      hasPlayerDecision,
  };
}
