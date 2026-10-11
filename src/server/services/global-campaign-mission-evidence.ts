import { z } from "zod";
import chapters from "~/data/story-chapters.json";
import { extractTemplates } from "../../../scripts/lib/wikitext.mjs";
import {
  extractFandomRewardSources,
  parseFandomEventHeader,
} from "../../../scripts/lib/fandom-campaign-adapter.mjs";
import { GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS } from "~/shared/global-reconciliation-config";
import {
  missionEvidenceSchema,
  missionRewardEvidenceSchema,
  sameMissionRewards as sameRewards,
} from "./global-mission-evidence";
import type { CampaignIdentityTarget } from "./global-campaign-identity";
import { campaignSourceWikitext } from "./global-jp-campaign-identity";
import { matchAnnouncementEvent } from "./global-announcement-match";
import {
  parsePublisherAnnouncement,
  publisherArticleUrl,
  type AnnouncementPeriod,
} from "./global-announcement-parser";
import type { PublisherArticle } from "./global-announcement-source";
import {
  missionSignature,
  normaliseMissionName,
} from "./global-mission-periods";

const text = z.string().min(1).max(LIMITS.maxContextCharacters);
const importedRewardsSchema = z.array(
  z
    .array(missionRewardEvidenceSchema.strip())
    .min(1)
    .max(LIMITS.maxPeriodsPerArticle),
);
const campaignMissionEvidenceSchema = z
  .object({
    kind: z.literal("CAMPAIGN_MISSION_DATES"),
    eventSourceKey: text,
    pageId: z.number().int().positive().safe(),
    revisionId: z.number().int().positive().safe(),
    jpHeader: text,
    chapterWarId: z.number().int().positive().safe(),
    globalArticle: z
      .object({
        url: text,
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        sourceRecordId: text,
        name: z.string().min(1).max(LIMITS.maxTitleCharacters),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      })
      .strict(),
    missions: z
      .array(
        missionEvidenceSchema.extend({
          rewards: missionEvidenceSchema.shape.rewards.max(
            LIMITS.maxPeriodsPerArticle,
          ),
        }),
      )
      .min(1)
      .max(LIMITS.maxPeriodsPerArticle),
  })
  .strict();
type CampaignMissionEvidence = z.infer<typeof campaignMissionEvidenceSchema>;
type Target = CampaignIdentityTarget & { name: string; startsAt: Date };
type Page = {
  pageId: number;
  revisionId: number;
  title: string;
  wikitext: string;
};
type ArticleBinding = CampaignMissionEvidence["globalArticle"];

// Only explicit catalogue aliases qualify. The campaign tag must be an exact
// imported/verified name, not a display-name correction or a broad substring.
function sectionSignature(
  label: string,
  warId: number,
  names: readonly string[],
) {
  const chapter = chapters.find((row) => row.warId === warId);
  const tag = /^\s*(?:\[([^\]]+)\]|【([^】]+)】)/u.exec(label);
  if (!chapter || !tag) return null;
  const scope = normaliseMissionName(tag[1] ?? tag[2]!);
  if (!names.some((name) => normaliseMissionName(name) === scope)) return null;
  const identifier = normaliseMissionName(chapter.originalName.split("\n")[0]!);
  if (!scope.startsWith(`${identifier} `)) return null;
  const body = normaliseMissionName(label.slice(tag[0].length));
  const aliases = new Set([identifier, normaliseMissionName(chapter.name)]);
  const section =
    /^(?:clear|complete) section (\d+)(?: (?:progress node|arrow) (\d+))? of (.+)$/u.exec(
      body,
    );
  if (section && aliases.has(section[3]!))
    return missionSignature(
      `[${scope}] Clear Section ${section[1]}${section[2] ? ` Progress Node ${section[2]}` : ""} of ${identifier}`,
      identifier,
    );
  const complete = /^(?:clear|complete) (.+)$/u.exec(body);
  if (complete && aliases.has(complete[1]!))
    return missionSignature(`[${scope}] Complete ${identifier}`, identifier);
  return null;
}

// This evidence cannot supply a title alias. The caller must already have a
// unique campaign match across all eligible events, then recheck it at publish.
export function verifyCampaignMissionEvidence(
  raw: unknown,
  event: Target,
  binding: ArticleBinding,
  verifiedNames: readonly string[] = [],
): CampaignMissionEvidence | null {
  const parsed = campaignMissionEvidenceSchema.safeParse(raw);
  if (
    !parsed.success ||
    event.type !== "CAMPAIGN" ||
    event.sourceRegion !== "JP"
  )
    return null;
  const proof = parsed.data;
  if (
    proof.eventSourceKey !== event.sourceKey ||
    event.sourceKey !== `fandom:JP:page:${proof.pageId}:projection:NA`
  )
    return null;
  for (const key of Object.keys(binding) as (keyof ArticleBinding)[])
    if (proof.globalArticle[key] !== binding[key]) return null;
  try {
    if (publisherArticleUrl(binding.url) !== binding.url) return null;
  } catch {
    return null;
  }
  const headerText = `{{${proof.jpHeader}}}`;
  if (extractTemplates(headerText, "EventHeaderJP").length !== 1) return null;
  const header = parseFandomEventHeader(headerText);
  if (
    header?.name !== event.name ||
    !/^(?:camp|campaign)$/iu.test(String(header.sourceType)) ||
    header.startsAt !== event.sourceStartsAt?.toISOString() ||
    header.endsAt !== event.sourceEndsAt?.toISOString()
  )
    return null;
  const names = [event.name, ...verifiedNames];
  const signatures = new Set<string>(),
    keys = new Set<string>();
  for (const mission of proof.missions) {
    if (
      signatures.has(mission.signature) ||
      sectionSignature(mission.official.label, proof.chapterWarId, names) !==
        mission.signature ||
      !sameRewards(mission.rewards, mission.official.rewards) ||
      mission.official.startsAt < binding.startsAt ||
      mission.official.endsAt > binding.endsAt
    )
      return null;
    signatures.add(mission.signature);
    const escaped = mission.official.missionPeriod
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const periods = parsePublisherAnnouncement(
      `<div class="article"><p>Event Period: ${escaped}</p></div>`,
      binding.url,
      new Date(0),
    ).periods;
    if (
      periods.length !== 1 ||
      periods[0]!.issues.length ||
      periods[0]!.startsAt !== mission.official.startsAt ||
      periods[0]!.endsAt !== mission.official.endsAt
    )
      return null;
    for (const reward of mission.rewards) {
      if (
        keys.has(reward.sourceKey) ||
        !reward.sourceKey.startsWith(`fandom:JP:page:${proof.pageId}:`) ||
        sectionSignature(reward.eligibility, proof.chapterWarId, names) !==
          mission.signature
      )
        return null;
      keys.add(reward.sourceKey);
    }
  }
  return proof;
}

export function buildCampaignMissionEvidence(
  page: Page,
  event: Target,
  article: PublisherArticle,
  period: AnnouncementPeriod,
  verifiedNames: readonly string[] = [],
): CampaignMissionEvidence | null {
  if (
    period.kind !== "CAMPAIGN" ||
    period.issues.length ||
    !period.startsAt ||
    !period.endsAt ||
    period.articleNameAllowed === false ||
    !article.missions?.length ||
    article.missions.length > LIMITS.maxPeriodsPerArticle
  )
    return null;
  if (
    matchAnnouncementEvent(period, article.name, [
      {
        id: event.id,
        type: "CAMPAIGN",
        names: [event.name, ...verifiedNames],
        startsAt: event.startsAt,
        projectedStartsAt: event.startsAt,
      },
    ]).targetEventId !== event.id
  )
    return null;
  const headers = extractTemplates(
    campaignSourceWikitext(page.wikitext),
    "EventHeaderJP",
  );
  if (headers.length !== 1) return null;
  const header = parseFandomEventHeader(`{{${headers[0]}}}`);
  if (!header?.startsAt || !header.endsAt || header.name !== page.title)
    return null;
  const sources = extractFandomRewardSources(page.wikitext, {
    pageId: page.pageId,
    eventName: page.title,
    eventSourceStartsAt: header.startsAt,
    eventSourceEndsAt: header.endsAt,
    eventSourceKey: event.sourceKey,
    evidenceSourceKey: event.sourceKey,
    evidenceUrl: article.sourceUrl,
    eventEndsAt: header.endsAt,
  }).rewardSources.filter((source) =>
    ["MASTER_MISSION", "LIMITED_MISSION"].includes(source.type),
  );
  if (sources.length !== article.missions.length) return null;
  const importedRewards = importedRewardsSchema.safeParse(
    sources.map((source) => source.rewards),
  );
  if (!importedRewards.success) return null;
  const binding = {
    url: article.sourceUrl,
    contentHash: article.contentHash,
    sourceRecordId: period.sourceRecordId,
    name: article.name,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
  };
  const names = [event.name, ...verifiedNames];
  const results: CampaignMissionEvidence[] = [];
  for (const chapter of chapters) {
    const official = new Map<string, (typeof article.missions)[number]>();
    for (const row of article.missions) {
      const signature = sectionSignature(row.label, chapter.warId, names);
      if (!signature || official.has(signature)) break;
      official.set(signature, row);
    }
    if (official.size !== article.missions.length) continue;
    const missions: CampaignMissionEvidence["missions"] = [];
    for (const rewards of importedRewards.data) {
      const signature = sectionSignature(
        rewards[0]!.eligibility,
        chapter.warId,
        names,
      );
      const row = signature ? official.get(signature) : null;
      if (
        !signature ||
        !row ||
        !sameRewards(rewards, row.rewards) ||
        missions.some((mission) => mission.signature === signature)
      )
        break;
      missions.push({ signature, rewards, official: row });
    }
    if (missions.length !== sources.length) continue;
    const proof = verifyCampaignMissionEvidence(
      {
        kind: "CAMPAIGN_MISSION_DATES",
        eventSourceKey: event.sourceKey,
        pageId: page.pageId,
        revisionId: page.revisionId,
        jpHeader: headers[0],
        chapterWarId: chapter.warId,
        globalArticle: binding,
        missions,
      },
      event,
      binding,
      verifiedNames,
    );
    if (proof) results.push(proof);
  }
  return results.length === 1 ? results[0]! : null;
}
