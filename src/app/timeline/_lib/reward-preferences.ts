import { z } from "zod";
import {
  hasCompletedStory,
  storyChapters,
  type StoryChapter,
} from "~/app/timeline/_lib/story-progress";
import type { PlayerForecastProfile } from "~/app/timeline/_lib/player-forecast";
import { storyEligibility } from "./story-eligibility";

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
  included: boolean | null,
): RewardPreferences {
  const includedByRewardId = { ...preferences.includedByRewardId };
  if (included === null) delete includedByRewardId[rewardId];
  else includedByRewardId[rewardId] = included;
  return { ...preferences, includedByRewardId };
}

export function resolveRewardInclusion(
  reward: {
    id: string;
    nature: string;
    defaultIncluded: boolean;
    storyWarId?: number | null;
    storyReleaseAt?: Date | null;
    eligibility?: string | null;
  },
  preferences: RewardPreferences,
  profile?: PlayerForecastProfile | null,
  catalogue: StoryChapter[] = storyChapters,
) {
  const hasPlayerDecision = Object.hasOwn(
    preferences.includedByRewardId,
    reward.id,
  );
  if (!hasPlayerDecision && reward.storyWarId && profile?.storyProgress) {
    const completed = hasCompletedStory(
      reward.storyWarId,
      profile.storyProgress,
      catalogue,
    );
    if (completed !== null) {
      const release = reward.storyReleaseAt?.toISOString().slice(0, 10);
      const newlyAvailable =
        release !== undefined && release > profile.snapshot.effectiveDate;
      return {
        included: completed && newlyAvailable,
        inclusionResolved: completed,
        inclusionReason: !completed
          ? "Story not marked complete. Include manually if you plan to finish it."
          : newlyAvailable
            ? "Included from your story progress."
            : "Story complete. This reward may already be in your starting balances. Include it only if it is unclaimed.",
      };
    }
  }
  if (!hasPlayerDecision && !reward.storyWarId && profile?.storyProgress) {
    const requirement = storyEligibility(
      reward.eligibility,
      profile.storyProgress,
      catalogue,
    );
    if (requirement && requirement.completed !== true) {
      return {
        included: false,
        inclusionResolved: false,
        inclusionReason:
          requirement.completed === false
            ? `Story requirement not met: ${requirement.requiredChapters.map((chapter) => chapter.name).join(", ")}. Include manually if you plan to meet it.`
            : "Story eligibility is not confirmed. Set your story progress or choose Include/Exclude.",
      };
    }
  }
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
