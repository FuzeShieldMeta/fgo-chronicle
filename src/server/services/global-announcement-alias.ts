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
  eventType: z.enum([
    "MAIN_EVENT",
    "CAMPAIGN",
    "PRE_RELEASE_CAMPAIGN",
    "QUEST_RELEASE",
  ]),
  sourceType: z.string().optional(),
  warIds: z.array(z.number().int().positive()),
  embeddedIds: z
    .array(z.string().regex(/^(shop|missions):[1-9]\d*$/))
    .optional(),
  evidence: z.object({
    sourceKind: z.literal("GLOBAL_GAME_DATA"),
    sourceRegion: z.literal("NA"),
    sourceRecordId: z.string(),
    url: z.string(),
  }),
  jpEvidence: z.object({
    record: z.object({
      id: z.number().int().positive(),
      type: z.string().optional(),
      warIds: z.array(z.number().int().positive()),
      embeddedIds: z
        .array(z.string().regex(/^(shop|missions):[1-9]\d*$/))
        .optional(),
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
  event: { id: string; sourceKey: string; sourceRegion: string; type?: string },
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
  const jp = source.jpEvidence.record;
  const embedded = source.embeddedIds ?? [];
  const jpEmbedded = jp.embeddedIds ?? [];
  const embeddedIdentity =
    ["CAMPAIGN", "PRE_RELEASE_CAMPAIGN"].includes(source.eventType) &&
    source.sourceType === "eventQuest" &&
    jp.type === source.sourceType &&
    !source.warIds.length &&
    !jp.warIds.length &&
    embedded.some((key) => jpEmbedded.includes(key)) &&
    new Set(embedded).size === embedded.length &&
    new Set(jpEmbedded).size === jpEmbedded.length;
  if (
    candidate.sourceRecordId !== id ||
    candidate.targetEventId !== event.id ||
    source.targetEventId !== event.id ||
    event.sourceRegion !== "JP" ||
    (event.type !== undefined && event.type !== source.eventType) ||
    event.sourceKey !== key ||
    source.projectedSourceKey !== key ||
    source.jpEvidence.record.id !== source.sourceRecordId ||
    source.evidence.sourceRecordId !== id ||
    source.evidence.url !== `https://api.atlasacademy.io/nice/NA/event/${id}` ||
    candidate.sourceUrl !== source.evidence.url ||
    (!source.warIds.length && !embeddedIdentity) ||
    new Set(source.warIds).size !== source.warIds.length ||
    JSON.stringify([...source.warIds].sort((a, b) => a - b)) !==
      JSON.stringify([...source.jpEvidence.record.warIds].sort((a, b) => a - b))
  )
    return null;
  return source.globalName;
}
