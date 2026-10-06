import { z } from "zod";
import type { GlobalEventCandidate } from "../../../generated/prisma";
import { GLOBAL_ANNOUNCEMENT_LIMITS } from "~/shared/global-reconciliation-config";

const identity = z.object({
  sourceRecordId: z.number().int().positive(),
  identity: z.literal("ASSOCIATED"),
  reasons: z.array(z.string()).length(0),
  targetEventId: z.string(),
  projectedSourceKey: z.string(),
  globalName: z
    .string()
    .trim()
    .min(1)
    .max(GLOBAL_ANNOUNCEMENT_LIMITS.maxTitleCharacters),
  eventType: z.literal("MAIN_EVENT"),
  warIds: z.array(z.number().int().positive()).min(1),
  evidence: z.object({
    sourceKind: z.literal("GLOBAL_GAME_DATA"),
    sourceRegion: z.literal("NA"),
    sourceRecordId: z.string(),
    url: z.string(),
  }),
  jpEvidence: z.object({
    record: z.object({
      id: z.number().int().positive(),
      warIds: z.array(z.number().int().positive()).min(1),
    }),
  }),
});

export function verifiedAtlasAlias(
  candidate: Pick<
    GlobalEventCandidate,
    | "sourceKind"
    | "sourceRecordId"
    | "sourceUrl"
    | "targetEventId"
    | "reasons"
    | "snapshot"
  >,
  event: { id: string; sourceKey: string; sourceRegion: string },
) {
  const parsed = identity.safeParse(candidate.snapshot);
  if (
    !parsed.success ||
    candidate.sourceKind !== "GLOBAL_GAME_DATA" ||
    candidate.reasons.length
  )
    return null;
  const source = parsed.data;
  const id = String(source.sourceRecordId);
  const key = `atlas:JP:event:${id}:projection:NA`;
  if (
    candidate.sourceRecordId !== id ||
    candidate.targetEventId !== event.id ||
    source.targetEventId !== event.id ||
    event.sourceRegion !== "JP" ||
    event.sourceKey !== key ||
    source.projectedSourceKey !== key ||
    source.jpEvidence.record.id !== source.sourceRecordId ||
    source.evidence.sourceRecordId !== id ||
    source.evidence.url !== `https://api.atlasacademy.io/nice/NA/event/${id}` ||
    candidate.sourceUrl !== source.evidence.url ||
    new Set(source.warIds).size !== source.warIds.length ||
    JSON.stringify([...source.warIds].sort((a, b) => a - b)) !==
      JSON.stringify([...source.jpEvidence.record.warIds].sort((a, b) => a - b))
  )
    return null;
  return source.globalName;
}
