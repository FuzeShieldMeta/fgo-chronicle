import { z } from "zod";
import {
  extractTemplates,
  parseTemplateParameters,
} from "../../../scripts/lib/wikitext.mjs";
import {
  parseFandomEventHeader,
  extractFandomRewardSources,
} from "../../../scripts/lib/fandom-campaign-adapter.mjs";
import { GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS } from "~/shared/global-reconciliation-config";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import {
  campaignSourceWikitext,
  jpCampaignArticleUrl,
  jpExchangePeriod,
  type AtlasCampaignAssessment,
  type parseJpCampaignArticle,
} from "./global-jp-campaign-identity";
import {
  publisherArticleUrl,
  parsePublisherAnnouncement,
} from "./global-announcement-parser";
import type { PublisherArticle } from "./global-announcement-source";
import type { CampaignIdentityTarget } from "./global-campaign-identity";
import {
  missionSignature,
  normaliseMissionName,
  type OfficialMissionRow,
} from "./global-mission-periods";
import {
  missionEvidenceSchema,
  missionRewardEvidenceSchema as reward,
  sameMissionRewards as sameRewards,
} from "./global-mission-evidence";

const text = z.string().min(1).max(LIMITS.maxContextCharacters);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const chapterMissionProofSchema = z
  .object({
    kind: z.literal("JP_CHAPTER_MISSIONS"),
    pageId: z.number().int().positive(),
    revisionId: z.number().int().positive(),
    title: z.string().min(1).max(LIMITS.maxTitleCharacters),
    jpHeader: text,
    atlasId: z.string().regex(/^[1-9]\d*$/u),
    atlasAssessmentHash: digest,
    article: z
      .object({
        url: text,
        title: text,
        contentHash: digest,
        retrievedAt: z.string().datetime(),
        campaignPeriod: text,
        chapterName: text,
      })
      .strict(),
    globalArticle: z
      .object({
        url: text,
        name: z.string().min(1).max(LIMITS.maxTitleCharacters),
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        chapterName: text,
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      })
      .strict(),
    missions: z
      .array(missionEvidenceSchema)
      .min(1)
      .max(LIMITS.maxPeriodsPerArticle),
  })
  .strict();
export type ChapterMissionProof = z.infer<typeof chapterMissionProofSchema>;
const atlasIdentity = z.object({
  titleAlias: z.object({ targetEventId: z.string() }).nullable().optional(),
  jpEvidence: z.object({
    record: z.object({ name: text, originalName: text.nullable().optional() }),
  }),
});
const canonical = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim();

export function hasChapterMissionCandidate(
  page: { title: string; wikitext: string },
  atlases: readonly AtlasCampaignAssessment[],
  announcements: readonly PublisherArticle[],
) {
  if (!/missions?/iu.test(page.wikitext)) return false;
  return atlases.some((atlas) => {
    const parsed = atlasIdentity.safeParse(atlas.snapshot);
    const id = parsed.success
      ? (parsed.data.titleAlias?.targetEventId ?? atlas.targetEventId)
      : null;
    if (!id) return false;
    const name = verifiedAtlasAlias(atlas, {
      id,
      sourceKey: `atlas:JP:event:${atlas.sourceRecordId}:projection:NA`,
      sourceRegion: "JP",
      type: "MAIN_EVENT",
    });
    return (
      !!name &&
      normaliseMissionName(page.title).includes(
        normaliseMissionName(name.split(":")[0]!),
      ) &&
      announcements.some(
        (article) =>
          article.missions?.length &&
          article.periods.some(
            (period) =>
              period.kind === "CAMPAIGN" && period.context.includes(name),
          ),
      )
    );
  });
}

export function verifiedChapterMissionAlias(
  raw: unknown,
  event: CampaignIdentityTarget,
  atlas?: AtlasCampaignAssessment,
) {
  const parsed = chapterMissionProofSchema.safeParse(raw);
  if (
    !parsed.success ||
    !atlas ||
    event.type !== "CAMPAIGN" ||
    event.sourceRegion !== "JP"
  )
    return null;
  const proof = parsed.data;
  const source = atlasIdentity.safeParse(atlas.snapshot);
  const targetId = source.success
    ? (source.data.titleAlias?.targetEventId ?? atlas.targetEventId)
    : null;
  if (
    !source.success ||
    !targetId ||
    atlas.sourceRecordId !== proof.atlasId ||
    atlas.assessmentHash !== proof.atlasAssessmentHash ||
    event.sourceKey !== `fandom:JP:page:${proof.pageId}:projection:NA`
  )
    return null;
  const chapter = verifiedAtlasAlias(atlas, {
    id: targetId,
    sourceKey: `atlas:JP:event:${proof.atlasId}:projection:NA`,
    sourceRegion: "JP",
    type: "MAIN_EVENT",
  });
  const headerText = `{{${proof.jpHeader}}}`;
  if (!chapter || extractTemplates(headerText, "EventHeaderJP").length !== 1)
    return null;
  const header = parseFandomEventHeader(headerText);
  const link: unknown = parseTemplateParameters(proof.jpHeader).get("link");
  const period = jpExchangePeriod(
    proof.article.campaignPeriod.replace("キャンペーン開催期間", "交換期間"),
  );
  if (
    header?.name !== proof.title ||
    !/^(?:camp|campaign)$/iu.test(String(header.sourceType)) ||
    header.startsAt !== event.sourceStartsAt?.toISOString() ||
    header.endsAt !== event.sourceEndsAt?.toISOString() ||
    !proof.article.campaignPeriod.includes("キャンペーン開催期間") ||
    period?.startsAt !== header.startsAt ||
    period.endsAt !== header.endsAt ||
    canonical(proof.article.chapterName) !==
      canonical(
        source.data.jpEvidence.record.originalName ??
          source.data.jpEvidence.record.name,
      ) ||
    canonical(proof.globalArticle.chapterName) !== canonical(chapter) ||
    typeof link !== "string"
  )
    return null;
  try {
    if (
      jpCampaignArticleUrl(link.trim()) !==
        jpCampaignArticleUrl(proof.article.url) ||
      publisherArticleUrl(proof.globalArticle.url) !== proof.globalArticle.url
    )
      return null;
  } catch {
    return null;
  }
  const signatures = new Set<string>(),
    keys = new Set<string>();
  for (const mission of proof.missions) {
    if (
      signatures.has(mission.signature) ||
      missionSignature(mission.official.label, chapter) !== mission.signature ||
      !sameRewards(mission.rewards, mission.official.rewards) ||
      mission.official.startsAt < proof.globalArticle.startsAt ||
      mission.official.endsAt > proof.globalArticle.endsAt
    )
      return null;
    signatures.add(mission.signature);
    const checked = parsePublisherAnnouncement(
      `<div class="article"><p>Event Period: ${mission.official.missionPeriod.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p></div>`,
      proof.globalArticle.url,
      new Date(0),
    ).periods;
    if (
      checked.length !== 1 ||
      checked[0]!.issues.length ||
      checked[0]!.startsAt !== mission.official.startsAt ||
      checked[0]!.endsAt !== mission.official.endsAt
    )
      return null;
    for (const definition of mission.rewards) {
      if (
        keys.has(definition.sourceKey) ||
        !definition.sourceKey.startsWith(`fandom:JP:page:${proof.pageId}:`) ||
        missionSignature(definition.eligibility, chapter) !== mission.signature
      )
        return null;
      keys.add(definition.sourceKey);
    }
  }
  return proof.globalArticle.name;
}

export function buildChapterMissionProof(
  page: { pageId: number; revisionId: number; title: string; wikitext: string },
  article: ReturnType<typeof parseJpCampaignArticle>,
  event: CampaignIdentityTarget,
  atlases: readonly AtlasCampaignAssessment[],
  announcements: readonly PublisherArticle[],
) {
  const headers = extractTemplates(
    campaignSourceWikitext(page.wikitext),
    "EventHeaderJP",
  );
  if (headers.length !== 1) return null;
  const header = parseFandomEventHeader(`{{${headers[0]}}}`);
  if (!header?.startsAt || !header.endsAt) return null;
  const sourceKey = `fandom:JP:page:${page.pageId}:projection:NA`;
  const sources = extractFandomRewardSources(page.wikitext, {
    pageId: page.pageId,
    eventName: page.title,
    eventSourceStartsAt: header.startsAt,
    eventSourceEndsAt: header.endsAt,
    eventSourceKey: sourceKey,
    evidenceSourceKey: sourceKey,
    evidenceUrl: article.url,
    eventEndsAt: header.endsAt,
  }).rewardSources.filter((source) =>
    ["MASTER_MISSION", "LIMITED_MISSION"].includes(source.type),
  );
  if (!sources.length || sources.length > LIMITS.maxPeriodsPerArticle)
    return null;
  const proofs: ChapterMissionProof[] = [];
  for (const atlas of atlases) {
    const identity = atlasIdentity.safeParse(atlas.snapshot);
    const id = identity.success
      ? (identity.data.titleAlias?.targetEventId ?? atlas.targetEventId)
      : null;
    if (!identity.success || !id) continue;
    const chapter = verifiedAtlasAlias(atlas, {
      id,
      sourceKey: `atlas:JP:event:${atlas.sourceRecordId}:projection:NA`,
      sourceRegion: "JP",
      type: "MAIN_EVENT",
    });
    const jpName =
      identity.data.jpEvidence.record.originalName ??
      identity.data.jpEvidence.record.name;
    if (
      !chapter ||
      !article.quotedNames.some(
        (name) => canonical(name) === canonical(jpName),
      ) ||
      !normaliseMissionName(page.title).includes(
        normaliseMissionName(chapter.split(":")[0]!),
      )
    )
      continue;
    for (const announcement of announcements) {
      const overall = announcement.periods.filter(
        (period) =>
          period.kind === "CAMPAIGN" &&
          period.articleNameAllowed !== false &&
          !period.issues.length &&
          period.startsAt &&
          period.endsAt &&
          [...period.context.matchAll(/"([^"\n]+)"/gu)].some(
            (match) => canonical(match[1]!) === canonical(chapter),
          ),
      );
      if (
        overall.length !== 1 ||
        !announcement.missions?.length ||
        announcement.missions.length !== sources.length
      )
        continue;
      const official = new Map<string, OfficialMissionRow>();
      let valid = true;
      for (const row of announcement.missions) {
        const signature = missionSignature(row.label, chapter);
        if (!signature || official.has(signature)) {
          valid = false;
          break;
        }
        official.set(signature, row);
      }
      if (!valid) continue;
      const missions: ChapterMissionProof["missions"] = [];
      for (const source of sources) {
        const definitions = z.array(reward.strip()).safeParse(source.rewards);
        if (!definitions.success) {
          valid = false;
          break;
        }
        const eligibility = definitions.data[0]?.eligibility;
        const signature = eligibility
          ? missionSignature(eligibility, chapter)
          : null;
        const row = signature ? official.get(signature) : null;
        if (!signature || !row || !sameRewards(definitions.data, row.rewards)) {
          valid = false;
          break;
        }
        missions.push({
          signature,
          rewards: definitions.data,
          official: row,
        });
      }
      if (!valid) continue;
      for (const campaignPeriod of article.campaignPeriods) {
        const parsed = chapterMissionProofSchema.safeParse({
          kind: "JP_CHAPTER_MISSIONS",
          pageId: page.pageId,
          revisionId: page.revisionId,
          title: page.title,
          jpHeader: headers[0],
          atlasId: atlas.sourceRecordId,
          atlasAssessmentHash: atlas.assessmentHash,
          article: {
            url: article.url,
            title: article.title,
            contentHash: article.contentHash,
            retrievedAt: article.retrievedAt,
            campaignPeriod,
            chapterName: jpName,
          },
          globalArticle: {
            url: announcement.sourceUrl,
            name: announcement.name,
            contentHash: announcement.contentHash,
            chapterName: chapter,
            startsAt: overall[0]!.startsAt,
            endsAt: overall[0]!.endsAt,
          },
          missions,
        });
        if (
          parsed.success &&
          verifiedChapterMissionAlias(parsed.data, event, atlas)
        )
          proofs.push(parsed.data);
      }
    }
  }
  return proofs.length === 1 ? proofs[0]! : null;
}
