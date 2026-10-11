import { z } from "zod";
import { GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS } from "~/shared/global-reconciliation-config";
import { officialMissionRowSchema } from "./global-mission-periods";

const text = z.string().min(1).max(LIMITS.maxContextCharacters);
export const missionRewardEvidenceSchema =
  officialMissionRowSchema.shape.rewards.element
    .extend({ sourceKey: text, eligibility: text })
    .strict();

export const missionEvidenceSchema = z
  .object({
    signature: text,
    rewards: z.array(missionRewardEvidenceSchema).min(1),
    official: officialMissionRowSchema,
  })
  .strict();
export type MissionEvidence = z.infer<typeof missionEvidenceSchema>;

export const sameMissionRewards = (
  a: readonly { itemType: string; amount: number }[],
  b: readonly { itemType: string; amount: number }[],
) =>
  JSON.stringify(a.map((r) => [r.itemType, r.amount]).sort()) ===
  JSON.stringify(b.map((r) => [r.itemType, r.amount]).sort());
