import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import type { GlobalEventCandidate } from "../../../generated/prisma";
import {
  parseFandomEventHeader,
  parseJstDateRange,
} from "../../../scripts/lib/fandom-campaign-adapter.mjs";
import {
  extractTemplates,
  parseTemplateParameters,
  plainWikitext,
} from "../../../scripts/lib/wikitext.mjs";
import {
  GLOBAL_ANNOUNCEMENT_LIMITS as BODY,
  GLOBAL_CAMPAIGN_IDENTITY_LIMITS as LIMITS,
} from "~/shared/global-reconciliation-config";
import { verifiedAtlasAlias } from "./global-announcement-alias";
import type { CampaignIdentityTarget } from "./global-campaign-identity";

export type AtlasCampaignAssessment = Pick<
  GlobalEventCandidate,
  | "sourceKind"
  | "sourceRecordId"
  | "sourceUrl"
  | "targetEventId"
  | "reasons"
  | "snapshot"
  | "assessmentHash"
>;
type Atlas = AtlasCampaignAssessment;
type Page = {
  pageId: number;
  revisionId: number;
  title: string;
  wikitext: string;
};
export function campaignSourceWikitext(value: string) {
  return value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(nowiki|pre|syntaxhighlight)\b[^>]*>[^]*?<\/\1\s*>/gi, "");
}
const text = z.string().min(1).max(BODY.maxContextCharacters);
const periodSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});
export const jpCampaignProofSchema = z
  .object({
    kind: z.literal("JP_PUBLISHER_ATLAS"),
    pageId: z.number().int().positive(),
    revisionId: z.number().int().positive(),
    title: z.string().min(1).max(BODY.maxTitleCharacters),
    jpHeader: text,
    wikiExchange: text,
    article: z
      .object({
        url: z.string(),
        title: text,
        exchange: text,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        retrievedAt: z.string().datetime(),
      })
      .strict(),
    atlasId: z.string().regex(/^[1-9]\d*$/),
    atlasAssessmentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type JpCampaignProof = z.infer<typeof jpCampaignProofSchema>;
const atlasRecord = z.object({
  sourceRecordId: z.number().int().positive(),
  jpEvidence: z.object({
    record: z.object({
      id: z.number().int().positive(),
      name: text,
      originalName: text.nullable().optional(),
      startedAt: z.number().int().positive(),
      endedAt: z.number().int().positive(),
    }),
  }),
});

export function jpCampaignArticleUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://news.fate-go.jp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/\d{4}\/[a-zA-Z0-9_-]+\/$/.test(url.pathname) ||
    url.pathname.length > BODY.maxArticlePathCharacters
  )
    throw new Error("Unsupported JP announcement URL.");
  return url.href;
}

const RANGE =
  /(?<sy>\d{4})年(?<sm>\d{1,2})月(?<sd>\d{1,2})日(?:\([^)]{1,8}\))?\s*(?<sh>\d{1,2}):(?<sn>\d{2})\s*[～〜~]\s*(?:(?<ey>\d{4})年)?(?<em>\d{1,2})月(?<ed>\d{1,2})日(?:\([^)]{1,8}\))?\s*(?<eh>\d{1,2}):(?<en>\d{2})/g;
function boundary(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute
  )
    return null;
  return new Date(
    local.getTime() - LIMITS.jstOffsetMinutes * 60_000,
  ).toISOString();
}
export function jpExchangePeriod(value: string) {
  if (!value.includes("交換期間") || /UTC|GMT|PDT|PST/i.test(value))
    return null;
  const matches = [...value.matchAll(RANGE)];
  if (matches.length !== 1) return null;
  const g = matches[0]!.groups!;
  const year = Number(g.sy),
    endYear = Number(g.ey ?? (Number(g.em) < Number(g.sm) ? year + 1 : year));
  const startsAt = boundary(
    year,
    Number(g.sm),
    Number(g.sd),
    Number(g.sh),
    Number(g.sn),
  );
  const endsAt = boundary(
    endYear,
    Number(g.em),
    Number(g.ed),
    Number(g.eh),
    Number(g.en),
  );
  return startsAt && endsAt && endsAt >= startsAt ? { startsAt, endsAt } : null;
}

export function parseJpCampaignArticle(
  body: string,
  url: string,
  retrievedAt = new Date(),
) {
  jpCampaignArticleUrl(url);
  if (Buffer.byteLength(body) > BODY.maxBodyBytes)
    throw new Error("The JP announcement exceeds the size limit.");
  type Node = DefaultTreeAdapterMap["node"];
  const stack: Node[] = [parse(body)],
    nodes: Node[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (["script", "style", "template", "noscript"].includes(node.nodeName))
      continue;
    nodes.push(node);
    if (nodes.length > BODY.maxTreeNodes)
      throw new Error("The JP announcement exceeds the parser limit.");
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  const plain = (root: Node): string => {
    const todo: Node[] = [root],
      parts: string[] = [];
    while (todo.length) {
      const node = todo.pop()!;
      if (["script", "style", "template", "noscript"].includes(node.nodeName))
        continue;
      if (node.nodeName === "#text" && "value" in node) parts.push(node.value);
      if ("childNodes" in node) todo.push(...[...node.childNodes].reverse());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  const title = nodes.find((node) => node.nodeName === "title");
  const exchanges = nodes
    .filter((node) => node.nodeName === "p")
    .map(plain)
    .filter(
      (value) =>
        value.length <= BODY.maxContextCharacters && jpExchangePeriod(value),
    );
  if (exchanges.length > BODY.maxPeriodsPerArticle)
    throw new Error("The JP announcement contains too many periods.");
  return {
    url,
    title: title ? plain(title) : "",
    exchanges,
    contentHash: createHash("sha256").update(body).digest("hex"),
    retrievedAt: retrievedAt.toISOString(),
  };
}

function wikiExchangePeriod(value: string) {
  if (!/(selector|exchange).*(duration|period)/i.test(value)) return null;
  const range =
    /[A-Za-z]+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*~\s*[A-Za-z]+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s+JST/.exec(
      value,
    )?.[0];
  const parsed = range ? parseJstDateRange(range) : null;
  const result = periodSchema.safeParse(
    parsed
      ? {
          startsAt: parsed.start.toISOString(),
          endsAt: parsed.end.toISOString(),
        }
      : null,
  );
  return result.success ? result.data : null;
}

export function verifiedJpCampaignAlias(
  raw: unknown,
  event: CampaignIdentityTarget,
  atlas?: Atlas,
) {
  const result = jpCampaignProofSchema.safeParse(raw);
  if (
    !result.success ||
    !atlas ||
    event.sourceRegion !== "JP" ||
    event.type !== "CAMPAIGN"
  )
    return null;
  const proof = result.data;
  if (
    event.sourceKey !== `fandom:JP:page:${proof.pageId}:projection:NA` ||
    atlas.sourceRecordId !== proof.atlasId ||
    atlas.assessmentHash !== proof.atlasAssessmentHash ||
    !atlas.targetEventId
  )
    return null;
  const headerText = `{{${proof.jpHeader}}}`;
  if (extractTemplates(headerText, "EventHeaderJP").length !== 1) return null;
  const header = parseFandomEventHeader(headerText);
  const sourceType: unknown = header?.sourceType;
  const link: unknown = parseTemplateParameters(proof.jpHeader).get("link");
  if (
    header?.name !== proof.title ||
    typeof sourceType !== "string" ||
    !/^(?:camp|campaign)$/i.test(sourceType) ||
    header.startsAt !== event.sourceStartsAt?.toISOString() ||
    header.endsAt !== event.sourceEndsAt?.toISOString() ||
    typeof link !== "string"
  )
    return null;
  try {
    if (
      jpCampaignArticleUrl(link.trim()) !==
      jpCampaignArticleUrl(proof.article.url)
    )
      return null;
  } catch {
    return null;
  }
  const record = atlasRecord.safeParse(atlas.snapshot);
  if (
    !record.success ||
    String(record.data.sourceRecordId) !== proof.atlasId ||
    record.data.jpEvidence.record.id !== record.data.sourceRecordId
  )
    return null;
  const jp = record.data.jpEvidence.record;
  const quotedNames = [...proof.article.title.matchAll(/「([^「」]+)」/g)].map(
    (match) => match[1],
  );
  if (
    quotedNames.length !== 1 ||
    quotedNames[0] !== (jp.originalName ?? jp.name)
  )
    return null;
  const wiki = wikiExchangePeriod(proof.wikiExchange),
    official = jpExchangePeriod(proof.article.exchange);
  if (
    !wiki ||
    wiki.startsAt !== official?.startsAt ||
    wiki.endsAt !== official?.endsAt ||
    Date.parse(wiki.startsAt) !== Math.floor(jp.startedAt / 60) * 60_000 ||
    Date.parse(wiki.endsAt) !== Math.floor(jp.endedAt / 60) * 60_000 ||
    !event.sourceStartsAt ||
    !event.sourceEndsAt ||
    Date.parse(wiki.startsAt) < event.sourceStartsAt.getTime() ||
    Date.parse(wiki.endsAt) > event.sourceEndsAt.getTime() ||
    (Date.parse(wiki.startsAt) === event.sourceStartsAt.getTime() &&
      Date.parse(wiki.endsAt) === event.sourceEndsAt.getTime())
  )
    return null;
  return verifiedAtlasAlias(atlas, {
    id: atlas.targetEventId,
    sourceKey: `atlas:JP:event:${proof.atlasId}:projection:NA`,
    sourceRegion: "JP",
    type: "CAMPAIGN",
  });
}

export function buildJpCampaignProof(
  page: Page,
  article: ReturnType<typeof parseJpCampaignArticle>,
  event: CampaignIdentityTarget,
  atlases: readonly Atlas[],
) {
  const headers = extractTemplates(
    campaignSourceWikitext(page.wikitext),
    "EventHeaderJP",
  );
  if (headers.length !== 1) return null;
  const exchanges = campaignSourceWikitext(page.wikitext)
    .split("\n")
    .map(plainWikitext)
    .filter((line) => wikiExchangePeriod(line));
  if (exchanges.length > BODY.maxPeriodsPerArticle) return null;
  const proofs: JpCampaignProof[] = [];
  const { exchanges: articleExchanges, ...articleMetadata } = article;
  for (const atlas of matchingJpCampaignAtlases(page, atlases))
    for (const wikiExchange of exchanges)
      for (const exchange of articleExchanges) {
        const parsed = jpCampaignProofSchema.safeParse({
          kind: "JP_PUBLISHER_ATLAS",
          pageId: page.pageId,
          revisionId: page.revisionId,
          title: page.title,
          jpHeader: headers[0],
          wikiExchange,
          article: { ...articleMetadata, exchange },
          atlasId: atlas.sourceRecordId,
          atlasAssessmentHash: atlas.assessmentHash,
        });
        if (
          parsed.success &&
          verifiedJpCampaignAlias(parsed.data, event, atlas)
        )
          proofs.push(parsed.data);
      }
  const unique = new Map(proofs.map((proof) => [proof.atlasId, proof]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

export function hasJpCampaignExchange(page: Page, atlases: readonly Atlas[]) {
  return matchingJpCampaignAtlases(page, atlases).length > 0;
}

function matchingJpCampaignAtlases(page: Page, atlases: readonly Atlas[]) {
  const exchanges = campaignSourceWikitext(page.wikitext)
    .split("\n")
    .map(plainWikitext)
    .flatMap((line) => {
      const period = wikiExchangePeriod(line);
      return period ? [period] : [];
    });
  if (exchanges.length > BODY.maxPeriodsPerArticle) return [];
  return atlases.filter((atlas) => {
    const parsed = atlasRecord.safeParse(atlas.snapshot);
    if (
      !parsed.success ||
      !atlas.targetEventId ||
      !verifiedAtlasAlias(atlas, {
        id: atlas.targetEventId,
        sourceKey: `atlas:JP:event:${atlas.sourceRecordId}:projection:NA`,
        sourceRegion: "JP",
        type: "CAMPAIGN",
      })
    )
      return false;
    const record = parsed.data.jpEvidence.record;
    return exchanges.some(
      (period) =>
        Date.parse(period.startsAt) ===
          Math.floor(record.startedAt / 60) * 60_000 &&
        Date.parse(period.endsAt) === Math.floor(record.endedAt / 60) * 60_000,
    );
  });
}

export async function fetchJpCampaignArticle(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
) {
  const response = await fetchFn(jpCampaignArticleUrl(url), {
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    ]),
  });
  if (
    !response.ok ||
    response.redirected ||
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/html")
  ) {
    await response.body?.cancel();
    throw new Error("The JP announcement could not be read.");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY.maxBodyBytes)
        throw new Error("The JP announcement exceeds the size limit.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return parseJpCampaignArticle(body, url);
}
