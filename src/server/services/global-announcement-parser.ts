import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import {
  GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS,
  GLOBAL_SUMMON_SECTION_LIMITS,
  SERVANT_RARITY_BY_LABEL,
} from "~/shared/global-reconciliation-config";

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
const RELEASE = new RegExp(
  `(?<start>\\d{4}-\\d{2}-\\d{2})[ \\t]+(?<startTime>\\d{2}:\\d{2})(?:[ \\t]+(?<startZone>${ZONE}))?`,
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
  articleNameAllowed?: boolean;
  subjectName?: string;
}

export function publisherArticleUrl(value: string) {
  const url = new URL(value, PUBLISHER_ORIGIN);
  if (
    url.origin !== PUBLISHER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#") ||
    url.pathname.length > LIMITS.maxArticlePathCharacters ||
    !/^\/\d{4}\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
  )
    throw new Error(
      "The announcement URL is not a supported publisher article.",
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  if (url.pathname.length > LIMITS.maxArticlePathCharacters)
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
    value.includes("?") ||
    value.includes("#") ||
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

function namedSubject(label: string) {
  const match = /^"([^"]+)"\s+(.+)$/u.exec(label);
  return match ? { name: match[1]!, label: match[2]! } : null;
}

function resolvedQuestSubject(
  subject: string,
  articleName: string,
  lines: readonly string[],
) {
  const normalise = (value: string) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const prefix = `${normalise(subject)}:`;
  const heading = normalise(articleName);
  const titles = new Map<string, string>();
  for (const line of lines) {
    for (const match of line.matchAll(/"([^"\n]+)"/gu)) {
      const title = match[1]!.trim();
      const key = normalise(title);
      // A short subject alone cannot identify a chapter. Its full title must
      // be quoted in the article and appear in that article's heading too.
      if (
        !questSubsection(articleName) &&
        key.startsWith(prefix) &&
        heading.includes(key) &&
        !questSubsection(title)
      )
        titles.set(key, title);
    }
  }
  return {
    name: titles.size === 1 ? [...titles.values()][0]! : subject,
    issue: titles.size > 1 ? "AMBIGUOUS_QUEST_SUBJECT" : null,
  };
}

function questSubsection(label: string) {
  return /\braid\b|\b(?:part|section|act|episode)\s+(?:\d+|[ivx]+)\b/iu.test(
    label.normalize("NFKC"),
  );
}

function periodKind(label: string): AnnouncementPeriodKind {
  const kinds: AnnouncementPeriodKind[] = [];
  if (/maintenance/i.test(label)) kinds.push("MAINTENANCE");
  if (/summon.*period|pickup.*period/i.test(label)) kinds.push("SUMMON");
  if (/exchange period|shop.*period/i.test(label)) kinds.push("SHOP");
  if (
    /(?:quest|chapter|story) (?:period|availability(?: period)?)/i.test(label)
  )
    kinds.push("QUEST");
  if (/login bonus.*period/i.test(label)) kinds.push("LOGIN_BONUS");
  if (/campaign period/i.test(label)) kinds.push("CAMPAIGN");
  if (/event period/i.test(label)) kinds.push("EVENT");
  return kinds.length === 1 ? kinds[0]! : "OTHER";
}

function summonSections(
  article: Node | undefined,
  periods: readonly AnnouncementPeriod[],
  sourceUrl: string,
  articleContentHash: string,
) {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const label = /^Pickup Summon Period\s*:/i;
  const columns = ["class", "rarity", "servant"] as const;
  const selected = periods.filter(
    (period) =>
      period.kind === "SUMMON" &&
      normalize(period.context)
        .toLowerCase()
        .endsWith(
          normalize(`pickup summon period: ${period.rawPeriod}`).toLowerCase(),
        ),
  );
  if (!article || !selected.length) return [];
  const nodes = walk(article);
  const text = new Map<Node, string>();
  const value = (node: Node) => {
    let result = text.get(node);
    if (result === undefined) {
      result = normalize(plainText(node).join(" "));
      text.set(node, result);
    }
    return result;
  };
  const blocks = nodes.filter(
    (node) => /^(?:p|h[1-6])$/u.test(node.nodeName) && label.test(value(node)),
  );
  const headings = nodes.filter(
    (node) =>
      /^(?:p|h[1-6])$/u.test(node.nodeName) &&
      /^Pickup Servants\s*:\s*$/i.test(value(node)),
  );
  const tables = nodes.filter((node) => {
    if (node.nodeName !== "table") return false;
    const header = walk(node).find((child) => child.nodeName === "tr");
    const cells =
      header && "childNodes" in header
        ? header.childNodes
            .filter((child) => child.nodeName === "th")
            .map(value)
        : [];
    return (
      cells.length === columns.length &&
      cells.map((cell) => cell.toLowerCase()).join("|") === columns.join("|")
    );
  });
  const order = new Map(nodes.map((node, index) => [node, index]));
  const cache = new Map<
    Node,
    { nodes: Node[]; dates: Node[]; tables: Node[]; headings: Node[] }
  >();
  const scope = (node: Node) => {
    let entry = cache.get(node);
    if (!entry) {
      const children = walk(node),
        members = new Set(children);
      entry = {
        nodes: children,
        dates: blocks.filter((child) => members.has(child)),
        tables: tables.filter((child) => members.has(child)),
        headings: headings.filter((child) => members.has(child)),
      };
      cache.set(node, entry);
    }
    return entry;
  };
  const sections = selected.map((period, index) => {
    const issues = [...period.issues];
    const block = blocks[index];
    const rawServants: { name: string; className: string; rarity: number }[] =
      [];
    let container: ReturnType<typeof scope> | null = null;
    if (
      !block ||
      blocks.length !== selected.length ||
      !value(block).endsWith(normalize(period.rawPeriod))
    )
      issues.push("PICKUP_DATE_BLOCK_UNRESOLVED");
    else {
      let ancestor: Node | null = block;
      for (
        let depth = 0;
        ancestor && depth < GLOBAL_SUMMON_SECTION_LIMITS.maxScopeDepth;
        depth++
      ) {
        // An article-wide date/table association would cross sibling sections.
        if (ancestor === article) break;
        const current = scope(ancestor);
        if (current.dates.length > 1) break;
        if (
          current.dates.length === 1 &&
          current.tables.length === 1 &&
          current.headings.length === 1 &&
          order.get(block)! < order.get(current.headings[0]!)! &&
          order.get(current.headings[0]!)! < order.get(current.tables[0]!)!
        ) {
          container = current;
          break;
        }
        ancestor = "parentNode" in ancestor ? ancestor.parentNode : null;
      }
      if (!container) issues.push("PICKUP_SECTION_SCOPE_UNRESOLVED");
    }
    const table = container?.tables[0];
    if (table) {
      const tableNodes = walk(table);
      if (
        tableNodes.some((node) => node !== table && node.nodeName === "table")
      )
        issues.push("NESTED_PICKUP_TABLE_UNSUPPORTED");
      const rows = tableNodes.filter((node) => node.nodeName === "tr");
      if (rows.length - 1 > GLOBAL_SUMMON_SECTION_LIMITS.maxMembers)
        issues.push("PICKUP_MEMBER_LIMIT_EXCEEDED");
      else
        for (const row of rows.slice(1)) {
          const cells =
            "childNodes" in row
              ? row.childNodes.filter((node) => node.nodeName === "td")
              : [];
          const values = cells.map(value).filter(Boolean);
          if (
            values.length !== columns.length ||
            cells.some(
              (cell) =>
                attribute(cell, "rowspan") &&
                attribute(cell, "rowspan") !== "1",
            )
          ) {
            issues.push("PICKUP_ROW_UNRESOLVED");
            continue;
          }
          const [className, stars, name] = values as [string, string, string];
          const match =
            /^(★{1,5})(?:\s*(?:\((SSR|SR|R|UC|C)\)|(SSR|SR|R|UC|C)))?$/u.exec(
              stars,
            );
          const rarity = match?.[1]?.length ?? 0;
          const rankLabel = match?.[2] ?? match?.[3];
          if (
            !rarity ||
            (rankLabel &&
              SERVANT_RARITY_BY_LABEL[rankLabel.toLowerCase()] !== rarity) ||
            name.length > GLOBAL_SUMMON_SECTION_LIMITS.maxLabelCharacters ||
            className.length > GLOBAL_SUMMON_SECTION_LIMITS.maxLabelCharacters
          ) {
            issues.push("PICKUP_ROW_UNRESOLVED");
            continue;
          }
          rawServants.push({ name, className, rarity });
        }
    }
    if (!rawServants.length) issues.push("PICKUP_ROSTER_UNAVAILABLE");
    if (
      new Set(rawServants.map((member) => JSON.stringify(member))).size !==
      rawServants.length
    )
      issues.push("DUPLICATE_PICKUP_MEMBER");
    const sectionId = container?.nodes
      .filter(
        (node) =>
          order.get(node)! <= order.get(block!)! && attribute(node, "id"),
      )
      .at(-1);
    let sourceSectionId = sectionId ? attribute(sectionId, "id")! : null;
    if (
      sourceSectionId &&
      sourceSectionId.length > GLOBAL_SUMMON_SECTION_LIMITS.maxLabelCharacters
    ) {
      issues.push("SOURCE_SECTION_ID_TOO_LONG");
      sourceSectionId = null;
    }
    const evidence = {
      version: 1,
      sourceUrl,
      articleContentHash,
      sourceSectionId,
      periodSourceRecordId: period.sourceRecordId,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      rawPeriod: period.rawPeriod,
      rawServants,
    };
    return {
      ...evidence,
      evidenceHash: createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex"),
      status: issues.length
        ? ("HELD" as const)
        : ("EXTRACTED_REVIEW_REQUIRED" as const),
      issues: [...new Set(issues)],
      identityConfirmed: false as const,
      publicationAllowed: false as const,
    };
  });
  const counts = new Map<string, number>();
  for (const section of sections)
    if (section.sourceSectionId)
      counts.set(
        section.sourceSectionId,
        (counts.get(section.sourceSectionId) ?? 0) + 1,
      );
  return sections.map((section) =>
    section.sourceSectionId && counts.get(section.sourceSectionId)! > 1
      ? {
          ...section,
          status: "HELD" as const,
          issues: [...section.issues, "DUPLICATE_SOURCE_SECTION_ID"],
        }
      : section,
  );
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
    const releaseLabel =
      /^(?:quest|chapter|story) (?:release date|available from)\s*:?\s*$/i;
    if (!matches.length) {
      const match = RELEASE.exec(line);
      const label = match ? line.slice(0, match.index).trim() : "";
      const releaseContext = label || (lines[index - 1] ?? "");
      const subject = namedSubject(releaseContext);
      if (match && releaseLabel.test(subject?.label ?? releaseContext)) {
        if (periods.length >= LIMITS.maxPeriodsPerArticle)
          throw new Error("The announcement has too many date ranges.");
        const groups = match.groups!;
        const start = boundary(
          groups.start!,
          groups.startTime,
          groups.startZone,
        );
        const resolved = subject
          ? resolvedQuestSubject(subject.name, name, lines)
          : null;
        periods.push({
          sourceRecordId: `${new URL(url).pathname}:period:${periods.length}`,
          kind: "QUEST",
          ...(subject
            ? { subjectName: resolved!.name, articleNameAllowed: false }
            : {}),
          context: lines
            .slice(Math.max(0, index - LIMITS.contextLines), index + 1)
            .join("\n")
            .slice(-LIMITS.maxContextCharacters),
          rawPeriod: match[0],
          startsAt: start.value,
          endsAt: null,
          startTimezone: groups.startZone ?? null,
          endTimezone: null,
          issues: [
            start.issue,
            resolved?.issue,
            questSubsection(
              `${subject?.name ?? ""} ${subject?.label ?? releaseContext}`,
            )
              ? "UNSUPPORTED_QUEST_SUBSECTION"
              : null,
          ].filter((issue): issue is string => !!issue),
          publicationAllowed: false,
        });
        continue;
      }
    }
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
      const subject = namedSubject(label);
      const kind =
        /\[New Chapter\]/i.test(name) &&
        /^"([^"]+)"/.test(inlineLabel) &&
        name.includes(/^"([^"]+)"/.exec(inlineLabel)![1]!) &&
        /will be available for a limited time during\s*$/i.test(inlineLabel)
          ? "QUEST"
          : periodKind(
              subject && /^period\s*:?$/i.test(subject.label)
                ? `${subject.name} ${subject.label}`
                : (subject?.label ?? label),
            );
      const periodIssues = [
        ...new Set(
          [start.issue, end.issue].filter((issue): issue is string => !!issue),
        ),
      ];
      const resolved =
        subject && kind === "QUEST"
          ? resolvedQuestSubject(subject.name, name, lines)
          : null;
      if (resolved?.issue) periodIssues.push(resolved.issue);
      if (start.value && end.value && end.value < start.value)
        periodIssues.push("INVALID_DATE_RANGE");
      if (kind === "OTHER") periodIssues.push("UNRESOLVED_PERIOD_CONTEXT");
      if (
        kind === "QUEST" &&
        questSubsection(`${subject?.name ?? ""} ${subject?.label ?? label}`)
      )
        periodIssues.push("UNSUPPORTED_QUEST_SUBSECTION");
      periods.push({
        sourceRecordId: `${new URL(url).pathname}:period:${periods.length}`,
        kind,
        articleNameAllowed:
          subject && kind === "QUEST"
            ? false
            : kind !== "CAMPAIGN" || periods.length === 0,
        ...(resolved ? { subjectName: resolved.name } : {}),
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
  const contentHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const pickups = summonSections(article, periods, url, contentHash);
  const relatedArticleUrls = new Set<string>();
  if (pickups.length && article)
    for (const node of walk(article)) {
      const href = attribute(node, "href");
      if (node.nodeName !== "a" || !href) continue;
      try {
        const related = publisherArticleUrl(new URL(href, url).href);
        if (related !== url) relatedArticleUrls.add(related);
        if (relatedArticleUrls.size > LIMITS.maxRelatedArticles) break;
      } catch {
        continue;
      }
    }
  if (relatedArticleUrls.size > LIMITS.maxRelatedArticles)
    issues.push("RELATED_ARTICLE_LIMIT_EXCEEDED");
  return {
    sourceKind: "PUBLISHER_ANNOUNCEMENT" as const,
    sourceUrl: url,
    sourceRecordId: new URL(url).pathname,
    name,
    retrievedAt: retrievedAt.toISOString(),
    contentHash,
    ...(pickups.length
      ? {
          summonSections: pickups,
          relatedArticleUrls: [...relatedArticleUrls]
            .sort()
            .slice(0, LIMITS.maxRelatedArticles),
        }
      : {}),
    periods,
    unsupportedDateContexts,
    issues,
    publicationAllowed: false as const,
  };
}
