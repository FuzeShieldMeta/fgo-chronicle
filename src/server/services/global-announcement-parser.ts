import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import { GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS } from "~/shared/global-reconciliation-config";

type Node = DefaultTreeAdapterMap["node"];
export const PUBLISHER_ORIGIN = "https://webview.fate-go.us";
const SKIPPED = new Set(["script", "style", "template", "noscript"]);
const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "tr",
  "table",
  "blockquote",
  "br",
]);
const ZONE_OFFSETS: Readonly<Record<string, number>> = {
  PST: -8,
  PDT: -7,
  UTC: 0,
  GMT: 0,
};
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_MINUTE = 60_000;
const ZONE =
  "[A-Z]{2,5}(?:\\s*[+-]\\d{1,2}(?::\\d{2})?)?(?:\\s*\\(GMT\\s*[+-]\\d{1,2}(?::\\d{2})?\\))?(?![A-Za-z0-9:+-]|\\s*\\(GMT)";
const RANGE = new RegExp(
  `(?<start>\\d{4}-\\d{2}-\\d{2})(?:[ \\t]+(?<startTime>\\d{2}:\\d{2}))?` +
    `(?:[ \\t]+(?<startZone>${ZONE}))?[ \\t]+[-–—~〜][ \\t]+` +
    `(?<end>(?:\\d{4}-)?\\d{2}-\\d{2})(?:[ \\t]+(?<endTime>\\d{2}:\\d{2}))?` +
    `(?:[ \\t]+(?<endZone>${ZONE}))?`,
  "g",
);

export type AnnouncementPeriodKind =
  | "EVENT"
  | "SUMMON"
  | "SHOP"
  | "MAINTENANCE"
  | "QUEST"
  | "LOGIN_BONUS"
  | "CAMPAIGN"
  | "OTHER";

export interface AnnouncementPeriod {
  sourceRecordId: string;
  kind: AnnouncementPeriodKind;
  context: string;
  rawPeriod: string;
  startsAt: string | null;
  endsAt: string | null;
  startTimezone: string | null;
  endTimezone: string | null;
  issues: string[];
  publicationAllowed: false;
}

export function publisherArticleUrl(value: string) {
  const url = new URL(value, PUBLISHER_ORIGIN);
  if (
    url.origin !== PUBLISHER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.length > LIMITS.maxArticlePathCharacters ||
    !/^\/\d{4}\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
  )
    throw new Error(
      "The announcement URL is not a supported publisher article.",
    );
  return url.href;
}

export function publisherIndexUrl(value: string) {
  const url = new URL(value, PUBLISHER_ORIGIN);
  if (
    url.origin !== PUBLISHER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.length > LIMITS.maxArticlePathCharacters ||
    !/^\/(?:maintenance\/)?(?:page\/[1-9]\d*\/)?$/.test(url.pathname)
  )
    throw new Error("The URL is not a supported publisher index.");
  return url.href;
}

export function discoverPublisherArticles(body: string, sourceUrl: string) {
  publisherIndexUrl(sourceUrl);
  if (Buffer.byteLength(body, "utf8") > LIMITS.maxBodyBytes)
    throw new Error("The announcement index exceeds the parser limit.");
  const nodes = walk(parse(body));
  const lists = nodes.filter((node) => hasClass(node, "list"));
  if (!lists.length)
    throw new Error("The publisher index has no supported article list.");
  const links = new Set<string>();
  for (const list of lists) {
    for (const node of walk(list)) {
      if (node.nodeName !== "a") continue;
      const href = attribute(node, "href");
      if (!href) continue;
      try {
        links.add(publisherArticleUrl(href));
      } catch {
        /* Ignore navigation and external links. */
      }
    }
  }
  const next = nodes.find(
    (node) => node.nodeName === "a" && hasClass(node, "next"),
  );
  let nextUrl: string | null = null;
  const href = next && attribute(next, "href");
  if (href) {
    try {
      nextUrl = publisherIndexUrl(href);
    } catch {
      /* Do not follow unsupported pagination. */
    }
  }
  return { articleUrls: [...links], nextUrl };
}

function attribute(node: Node, name: string) {
  return "attrs" in node
    ? node.attrs.find((item) => item.name === name)?.value
    : undefined;
}

function hasClass(node: Node, name: string) {
  return attribute(node, "class")?.split(/\s+/).includes(name) ?? false;
}

function walk(root: Node) {
  const nodes: Node[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if (nodes.length > LIMITS.maxTreeNodes)
      throw new Error("The announcement HTML exceeds the parser limit.");
    if ("tagName" in node && SKIPPED.has(node.tagName)) continue;
    if ("childNodes" in node)
      for (const child of [...node.childNodes].reverse()) pending.push(child);
  }
  return nodes;
}

function plainText(root: Node) {
  const chunks: string[] = [];
  const pending: Array<{ node: Node; closing?: boolean }> = [{ node: root }];
  let count = 0;
  while (pending.length) {
    if (++count > LIMITS.maxTreeNodes * 2)
      throw new Error("The announcement text exceeds the parser limit.");
    const { node, closing } = pending.pop()!;
    if (closing) {
      chunks.push("\n");
      continue;
    }
    if (node.nodeName === "#text" && "value" in node) chunks.push(node.value);
    if ("tagName" in node && SKIPPED.has(node.tagName)) continue;
    const block = "tagName" in node && BLOCKS.has(node.tagName);
    if (block) chunks.push("\n");
    if ("tagName" in node && ["td", "th"].includes(node.tagName))
      chunks.push(" ");
    if (block) pending.push({ node, closing: true });
    if ("childNodes" in node)
      for (const child of [...node.childNodes].reverse())
        pending.push({ node: child });
  }
  return chunks
    .join("")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function zoneOffset(zone: string | undefined) {
  if (!zone) return { issue: "MISSING_TIMEZONE" };
  const match = /^([A-Z]+)(?:\s*\(GMT\s*([+-]\d+)\))?$/.exec(zone);
  const offset = ZONE_OFFSETS[match?.[1] ?? ""];
  if (offset === undefined) return { issue: "UNSUPPORTED_TIMEZONE" };
  if (match?.[2] !== undefined && Number(match[2]) !== offset)
    return { issue: "CONFLICTING_TIMEZONE_OFFSET" };
  return { offset };
}

function boundary(
  date: string,
  time: string | undefined,
  zone: string | undefined,
) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time ?? "00:00").split(":").map(Number);
  const local = new Date(Date.UTC(year!, month! - 1, day, hour, minute));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute
  )
    return { value: null, issue: "INVALID_CALENDAR_DATE" };
  const parsedZone = zoneOffset(zone);
  if (parsedZone.issue) return { value: null, issue: parsedZone.issue };
  if (!time) return { value: null, issue: "MISSING_BOUNDARY_TIME" };
  return {
    value: new Date(
      local.getTime() -
        parsedZone.offset! * MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE,
    ).toISOString(),
  };
}

function periodKind(label: string): AnnouncementPeriodKind {
  const kinds: AnnouncementPeriodKind[] = [];
  if (/maintenance/i.test(label)) kinds.push("MAINTENANCE");
  if (/summon.*period|pickup.*period/i.test(label)) kinds.push("SUMMON");
  if (/exchange period|shop.*period/i.test(label)) kinds.push("SHOP");
  if (/quest period|quest availability/i.test(label)) kinds.push("QUEST");
  if (/login bonus.*period/i.test(label)) kinds.push("LOGIN_BONUS");
  if (/campaign period/i.test(label)) kinds.push("CAMPAIGN");
  if (/event period/i.test(label)) kinds.push("EVENT");
  return kinds.length === 1 ? kinds[0]! : "OTHER";
}

export function parsePublisherAnnouncement(
  body: string,
  sourceUrl: string,
  retrievedAt: Date,
) {
  const url = publisherArticleUrl(sourceUrl);
  if (!Number.isFinite(retrievedAt.getTime()))
    throw new Error("The retrieval time is invalid.");
  if (Buffer.byteLength(body, "utf8") > LIMITS.maxBodyBytes)
    throw new Error("The announcement body exceeds the parser limit.");
  const nodes = walk(parse(body));
  const article = nodes.find((node) => hasClass(node, "article"));
  const titleNode = nodes.find((node) => hasClass(node, "title-box"));
  const title =
    titleNode && walk(titleNode).find((node) => hasClass(node, "title"));
  const fallback = nodes.find((node) => node.nodeName === "title");
  const name = plainText(title ?? fallback ?? parse(""))
    .join(" ")
    .slice(0, LIMITS.maxTitleCharacters);
  const issues: string[] = [];
  const periods: AnnouncementPeriod[] = [];
  const unsupportedDateContexts: string[] = [];
  if (!article) issues.push("MISSING_ARTICLE_CONTENT");
  if (article && walk(article).some((node) => node.nodeName === "iframe"))
    issues.push("EMBEDDED_CONTENT_NOT_FETCHED");
  const lines = article ? plainText(article) : [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const matches = [...line.matchAll(RANGE)];
    if (
      !matches.length &&
      (/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(line) ||
        (periodKind(line) !== "OTHER" &&
          !lines
            .slice(index + 1, index + 3)
            .some((nextLine) => [...nextLine.matchAll(RANGE)].length)))
    ) {
      if (unsupportedDateContexts.length >= LIMITS.maxPeriodsPerArticle)
        throw new Error(
          "The announcement has too many unsupported date contexts.",
        );
      unsupportedDateContexts.push(
        lines
          .slice(Math.max(0, index - 1), index + 2)
          .join("\n")
          .slice(0, LIMITS.maxContextCharacters),
      );
    }
    for (const match of matches) {
      if (periods.length >= LIMITS.maxPeriodsPerArticle)
        throw new Error("The announcement has too many date ranges.");
      const groups = match.groups!;
      const startZone = groups.startZone ?? groups.endZone;
      const endZone = groups.endZone ?? groups.startZone;
      const endDate =
        groups.end!.length === 5
          ? `${groups.start!.slice(0, 4)}-${groups.end}`
          : groups.end!;
      const start = boundary(groups.start!, groups.startTime, startZone);
      const end = boundary(endDate, groups.endTime, endZone);
      const context = lines
        .slice(Math.max(0, index - LIMITS.contextLines), index + 1)
        .join("\n")
        .slice(-LIMITS.maxContextCharacters);
      const inlineLabel = line.slice(0, match.index).trim();
      const label = inlineLabel.length ? inlineLabel : (lines[index - 1] ?? "");
      const kind = periodKind(label);
      const periodIssues = [
        ...new Set(
          [start.issue, end.issue].filter((issue): issue is string => !!issue),
        ),
      ];
      if (start.value && end.value && end.value < start.value)
        periodIssues.push("INVALID_DATE_RANGE");
      if (kind === "OTHER") periodIssues.push("UNRESOLVED_PERIOD_CONTEXT");
      periods.push({
        sourceRecordId: `${new URL(url).pathname}:period:${periods.length}`,
        kind,
        context,
        rawPeriod: match[0],
        startsAt: start.value,
        endsAt: end.value,
        startTimezone: startZone ?? null,
        endTimezone: endZone ?? null,
        issues: periodIssues,
        publicationAllowed: false,
      });
    }
  }
  if (!periods.length) issues.push("NO_SUPPORTED_DATE_RANGES");
  if (unsupportedDateContexts.length) issues.push("UNEXTRACTED_DATE_CONTEXT");
  return {
    sourceKind: "PUBLISHER_ANNOUNCEMENT" as const,
    sourceUrl: url,
    sourceRecordId: new URL(url).pathname,
    name,
    retrievedAt: retrievedAt.toISOString(),
    contentHash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    periods,
    unsupportedDateContexts,
    issues,
    publicationAllowed: false as const,
  };
}
