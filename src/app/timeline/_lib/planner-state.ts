import { z } from "zod";

import {
  playerForecastProfileSchema,
  type PlayerForecastProfile,
} from "~/app/timeline/_lib/player-forecast";
import {
  createRewardPreferences,
  rewardPreferencesSchema,
  type RewardPreferences,
} from "~/app/timeline/_lib/reward-preferences";
import {
  summonSessionSchema,
  type SummonSession,
} from "~/app/timeline/_lib/summon-session";

export const plannerStatePayloadSchema = z.object({
  version: z.literal(1),
  profile: playerForecastProfileSchema.nullable(),
  rewardPreferences: rewardPreferencesSchema,
  summonSessions: z.array(summonSessionSchema),
});

export type PlannerStatePayload = z.infer<typeof plannerStatePayloadSchema>;

export type PlannerCloudSnapshot = {
  payload: PlannerStatePayload;
  revision: number;
  updatedAt: Date;
};

export const plannerSyncMarkerSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  revision: z.number().int().positive(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type PlannerSyncMarker = z.infer<typeof plannerSyncMarkerSchema>;

export const plannerSyncMarkerStorageKey = "fgo-chronicle:planner-sync:v1";

export function createPlannerStatePayload({
  profile,
  rewardPreferences,
  summonSessions,
}: {
  profile: PlayerForecastProfile | null;
  rewardPreferences: RewardPreferences;
  summonSessions: SummonSession[];
}): PlannerStatePayload {
  return plannerStatePayloadSchema.parse({
    version: 1,
    profile,
    rewardPreferences,
    summonSessions,
  });
}

export function createEmptyPlannerStatePayload(): PlannerStatePayload {
  return {
    version: 1,
    profile: null,
    rewardPreferences: createRewardPreferences(),
    summonSessions: [],
  };
}

export function hasMeaningfulPlannerData(payload: PlannerStatePayload) {
  return (
    payload.profile !== null ||
    Object.keys(payload.rewardPreferences.includedByRewardId).length > 0 ||
    payload.summonSessions.length > 0
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalPlannerStateJson(payload: PlannerStatePayload) {
  return JSON.stringify(canonicalize(plannerStatePayloadSchema.parse(payload)));
}

export async function hashPlannerState(payload: PlannerStatePayload) {
  const bytes = new TextEncoder().encode(canonicalPlannerStateJson(payload));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function loadPlannerSyncMarker(
  storage: Storage,
  userId: string,
): PlannerSyncMarker | null {
  try {
    const stored = storage.getItem(plannerSyncMarkerStorageKey);
    if (!stored) return null;
    const result = plannerSyncMarkerSchema.safeParse(JSON.parse(stored));
    return result.success && result.data.userId === userId ? result.data : null;
  } catch {
    return null;
  }
}

export function savePlannerSyncMarker(
  storage: Storage,
  marker: PlannerSyncMarker,
) {
  storage.setItem(
    plannerSyncMarkerStorageKey,
    JSON.stringify(plannerSyncMarkerSchema.parse(marker)),
  );
}

export type PlannerReconciliation =
  | { action: "IDLE" }
  | { action: "ACCEPT_CLOUD" }
  | { action: "USE_CLOUD" }
  | { action: "UPLOAD"; expectedRevision: number | null }
  | { action: "CONFLICT" };

export function reconcilePlannerCopies({
  localMeaningful,
  localHash,
  cloud,
  cloudHash,
  marker,
}: {
  localMeaningful: boolean;
  localHash: string;
  cloud: PlannerCloudSnapshot | null;
  cloudHash: string | null;
  marker: PlannerSyncMarker | null;
}): PlannerReconciliation {
  if (!cloud) {
    return localMeaningful
      ? { action: "UPLOAD", expectedRevision: null }
      : { action: "IDLE" };
  }
  if (localHash === cloudHash) return { action: "ACCEPT_CLOUD" };
  if (!marker) {
    return localMeaningful ? { action: "CONFLICT" } : { action: "USE_CLOUD" };
  }

  const localChanged = localHash !== marker.payloadHash;
  const cloudChanged = cloudHash !== marker.payloadHash;
  if (!localChanged && cloudChanged) return { action: "USE_CLOUD" };
  if (localChanged && !cloudChanged) {
    return { action: "UPLOAD", expectedRevision: cloud.revision };
  }
  return { action: "CONFLICT" };
}
