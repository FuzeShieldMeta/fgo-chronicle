import { createHash } from "node:crypto";
import { z } from "zod";
import {
  extractTemplates,
  parseTemplateParameters,
  plainWikitext,
} from "../../../scripts/lib/wikitext.mjs";
import { parseFandomEventHeader } from "../../../scripts/lib/fandom-campaign-adapter.mjs";
import {
  buildJpCampaignProof,
  campaignSourceWikitext,
  hasJpCampaignExchange,
  fetchJpCampaignArticle,
  jpCampaignArticleUrl,
  verifiedJpCampaignAlias,
  type JpCampaignProof,
  type AtlasCampaignAssessment,
} from "./global-jp-campaign-identity";
import {
  GLOBAL_CAMPAIGN_IDENTITY_LIMITS as LIMITS,
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_ANNOUNCEMENT_LIMITS,
} from "~/shared/global-reconciliation-config";

const API = "https://fategrandorder.fandom.com/api.php";
const header = z.string().min(1).max(GLOBAL_SOURCE_LIMITS.maxSnapshotBytes);
const proofSchema = z
  .object({
    pageId: z.number().int().positive(),
    revisionId: z.number().int().positive(),
    title: z.string().min(1).max(GLOBAL_ANNOUNCEMENT_LIMITS.maxTitleCharacters),
    jpHeader: header,
    naHeader: header,
    headerHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CampaignIdentityProof =
  z.infer<typeof proofSchema> | JpCampaignProof;
export type CampaignIdentityTarget = {
  id: string;
  type: string;
  sourceKey: string;
  sourceRegion: string;
  sourceStartsAt: Date | null;
  sourceEndsAt: Date | null;
};

const hashHeaders = (jp: string, na: string) =>
  createHash("sha256")
    .update(JSON.stringify([jp, na]))
    .digest("hex");

export function verifiedRegionalCampaignAlias(
  raw: unknown,
  event: CampaignIdentityTarget,
  atlas?: AtlasCampaignAssessment,
) {
  if (
    raw &&
    typeof raw === "object" &&
    "kind" in raw &&
    raw.kind === "JP_PUBLISHER_ATLAS"
  )
    return verifiedJpCampaignAlias(raw, event, atlas);
  const parsed = proofSchema.safeParse(raw);
  if (
    !parsed.success ||
    event.sourceRegion !== "JP" ||
    !["CAMPAIGN", "PRE_RELEASE_CAMPAIGN"].includes(event.type)
  )
    return null;
  const proof = parsed.data;
  if (
    event.sourceKey !== `fandom:JP:page:${proof.pageId}:projection:NA` ||
    proof.headerHash !== hashHeaders(proof.jpHeader, proof.naHeader)
  )
    return null;
  const jpText = `{{${proof.jpHeader}}}`;
  const naText = `{{${proof.naHeader}}}`;
  if (
    extractTemplates(jpText, "EventHeaderJP").length !== 1 ||
    extractTemplates(naText, "EventHeaderNA").length !== 1
  )
    return null;
  const jp = parseFandomEventHeader(jpText);
  const na = parseTemplateParameters(proof.naHeader);
  const jpType: unknown = jp?.sourceType;
  if (
    jp?.name !== proof.title ||
    typeof jpType !== "string" ||
    !/^(?:camp|campaign)$/i.test(jpType) ||
    !jp.startsAt ||
    !jp.endsAt ||
    new Date(jp.startsAt).getTime() !== event.sourceStartsAt?.getTime() ||
    new Date(jp.endsAt).getTime() !== event.sourceEndsAt?.getTime()
  )
    return null;
  const nameValue: unknown = na.get("name") ?? na.get("pagename") ?? "";
  if (typeof nameValue !== "string") return null;
  const name = plainWikitext(nameValue)
    .replace(/\s*\((?:US|NA)\)\s*$/i, "")
    .trim();
  return name && name.length <= GLOBAL_ANNOUNCEMENT_LIMITS.maxTitleCharacters
    ? name
    : null;
}

export function pairedRegionalCampaignProof(page: {
  pageId: number;
  revisionId: number;
  title: string;
  wikitext: string;
}): z.infer<typeof proofSchema> | null {
  const text = page.wikitext
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(nowiki|pre|syntaxhighlight)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
  const jp = extractTemplates(text, "EventHeaderJP");
  const na = extractTemplates(text, "EventHeaderNA");
  if (jp.length !== 1 || na.length !== 1) return null;
  const proof = proofSchema.safeParse({
    pageId: page.pageId,
    revisionId: page.revisionId,
    title: page.title,
    jpHeader: jp[0],
    naHeader: na[0],
    headerHash: hashHeaders(jp[0]!, na[0]!),
  });
  return proof.success ? proof.data : null;
}

// Fetch only canonical page IDs from server-owned event records.
export async function loadRegionalCampaignProofs(
  events: readonly CampaignIdentityTarget[],
  fetchFn: typeof fetch = fetch,
  atlases: readonly AtlasCampaignAssessment[] = [],
) {
  const ids = [
    ...new Set(
      events.flatMap((event) => {
        const match = /^fandom:JP:page:([1-9]\d*):projection:NA$/.exec(
          event.sourceKey,
        );
        return match ? [match[1]!] : [];
      }),
    ),
  ];
  if (!ids.length) return new Map<string, CampaignIdentityProof>();
  if (ids.length > LIMITS.maxPages)
    throw new Error("The campaign identity lookup exceeds the page limit.");
  const url = new URL(API);
  url.search = new URLSearchParams({
    action: "query",
    prop: "revisions",
    pageids: ids.join("|"),
    rvprop: "ids|content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
  }).toString();
  const response = await fetchFn(url, {
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
  });
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error("The campaign identity source could not be read.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "",
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.maxBodyBytes)
        throw new Error(
          "The campaign identity response exceeds the size limit.",
        );
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const parsed = z
    .object({
      query: z.object({
        pages: z
          .array(
            z.object({
              pageid: z.number().int().positive().optional(),
              title: z.string(),
              revisions: z
                .array(
                  z.object({
                    revid: z.number().int().positive(),
                    slots: z.object({
                      main: z.object({ content: z.string() }),
                    }),
                  }),
                )
                .optional(),
            }),
          )
          .max(LIMITS.maxPages),
      }),
    })
    .parse(JSON.parse(body));
  const result = new Map<string, CampaignIdentityProof>();
  const articles = new Map<
    string,
    Awaited<ReturnType<typeof fetchJpCampaignArticle>>
  >();
  const signal = AbortSignal.timeout(LIMITS.collectionTimeoutMs);
  const seen = new Set<number>();
  for (const page of parsed.query.pages) {
    if (!page.pageid) continue;
    if (!ids.includes(String(page.pageid)) || seen.has(page.pageid))
      throw new Error(
        "The campaign identity source returned an unexpected page.",
      );
    seen.add(page.pageid);
    const revision = page.revisions?.[0];
    if (!revision) continue;
    const sourcePage = {
      pageId: page.pageid,
      revisionId: revision.revid,
      title: page.title,
      wikitext: revision.slots.main.content,
    };
    let proof: CampaignIdentityProof | null =
      pairedRegionalCampaignProof(sourcePage);
    if (!proof && hasJpCampaignExchange(sourcePage, atlases)) {
      const headers = extractTemplates(
        campaignSourceWikitext(sourcePage.wikitext),
        "EventHeaderJP",
      );
      const link: unknown =
        headers.length === 1
          ? parseTemplateParameters(headers[0]!).get("link")
          : null;
      let articleUrl: string | null = null;
      if (typeof link === "string") {
        try {
          articleUrl = jpCampaignArticleUrl(link.trim());
        } catch {
          /* Unsupported links do not establish identity. */
        }
      }
      const event = events.find(
        (row) =>
          row.sourceKey === `fandom:JP:page:${page.pageid}:projection:NA`,
      );
      if (articleUrl && event) {
        let article = articles.get(articleUrl);
        if (!article) {
          if (articles.size >= LIMITS.maxOfficialArticles)
            throw new Error(
              "The JP announcement lookup exceeds the article limit.",
            );
          article = await fetchJpCampaignArticle(articleUrl, fetchFn, signal);
          articles.set(articleUrl, article);
        }
        proof = buildJpCampaignProof(sourcePage, article, event, atlases);
      }
    }
    if (proof) result.set(`fandom:JP:page:${page.pageid}:projection:NA`, proof);
  }
  return result;
}
