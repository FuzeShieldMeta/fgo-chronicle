import { z } from "zod";
import type { GlobalEventCandidate } from "../../../generated/prisma";
import { GLOBAL_ANNOUNCEMENT_LIMITS } from "~/shared/global-reconciliation-config";

const identity = z.object({
  sourceRecordId: z.number().int().positive(),
  identity: z.enum(["ASSOCIATED", "UNRESOLVED"]),
  reasons: z.array(z.string()),
  targetEventId: z.string().nullable(),
  titleAlias: z
    .object({
      scope: z.literal("TITLE_ONLY"),
      targetEventId: z.string().min(1),
    })
    .strict()
    .nullable()
    .optional(),
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
    url: z.string().optional(),
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
  if (!parsed.success || candidate.sourceKind !== "GLOBAL_GAME_DATA")
    return null;
  const source = parsed.data;
  const id = String(source.sourceRecordId);
  const key = `atlas:JP:event:${id}:projection:NA`;
  const jp = source.jpEvidence.record;
  const embedded = source.embeddedIds ?? [];
  const jpEmbedded = jp.embeddedIds ?? [];
  const titleOnly =
    source.identity === "UNRESOLVED" &&
    source.reasons.length === 1 &&
    source.reasons[0] === "MISSING_WAR_ASSOCIATION" &&
    candidate.reasons.length === 1 &&
    candidate.reasons[0] === "MISSING_WAR_ASSOCIATION" &&
    candidate.targetEventId === null &&
    source.targetEventId === null &&
    source.titleAlias?.targetEventId === event.id &&
    source.jpEvidence.url ===
      `https://api.atlasacademy.io/nice/JP/event/${id}` &&
    source.sourceType === "eventQuest" &&
    jp.type === source.sourceType &&
    event.type === source.eventType &&
    !source.warIds.length &&
    !jp.warIds.length &&
    source.embeddedIds?.length === 0 &&
    jp.embeddedIds?.length === 0;
  const associated =
    source.identity === "ASSOCIATED" &&
    !source.reasons.length &&
    !candidate.reasons.length &&
    candidate.targetEventId === event.id &&
    source.targetEventId === event.id;
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
    (!associated && !titleOnly) ||
    event.sourceRegion !== "JP" ||
    (event.type !== undefined && event.type !== source.eventType) ||
    event.sourceKey !== key ||
    source.projectedSourceKey !== key ||
    source.jpEvidence.record.id !== source.sourceRecordId ||
    source.evidence.sourceRecordId !== id ||
    source.evidence.url !== `https://api.atlasacademy.io/nice/NA/event/${id}` ||
    candidate.sourceUrl !== source.evidence.url ||
    (!source.warIds.length && !embeddedIdentity && !titleOnly) ||
    new Set(source.warIds).size !== source.warIds.length ||
    JSON.stringify([...source.warIds].sort((a, b) => a - b)) !==
      JSON.stringify([...source.jpEvidence.record.warIds].sort((a, b) => a - b))
  )
    return null;
  return source.globalName;
}
