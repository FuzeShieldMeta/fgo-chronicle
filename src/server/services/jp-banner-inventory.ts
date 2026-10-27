import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { extractJpBannerSchedule } from "./jp-banner-schedule";
import { previewJpBannerProjection } from "./jp-banner-projection";
import {
  jpBannerImageUrl,
  inspectJpBannerImage,
  jpBannerImageEvidence,
  JP_BANNER_IMAGE_LIMITS,
} from "./jp-banner-images";
import {
  fetchJpBannerServantCatalogue,
  resolveJpBannerServantMentions,
  JP_BANNER_SERVANT_SOURCE,
  associateJpBannerPickupEvidence,
} from "./jp-banner-servants";

const ORIGIN = "https://news.fate-go.jp";
export const JP_BANNER_INVENTORY_LIMITS = {
  defaultPages: 2,
  maxPages: 50,
  maxPageNumber: 5_000,
  maxBodyBytes: 2 * 1_024 * 1_024,
  maxNodes: 50_000,
  maxEntriesPerPage: 100,
  maxTitleCharacters: 1_000,
  maxArticleInspections: 20,
  maxDiscoveredLinkedArticles: 200,
  maxEvidenceBlocks: 80,
  maxEvidenceCharacters: 4_000,
  maxImageReferences: 100,
  maxLinkedArticles: 100,
  requestTimeoutMs: 15_000,
  collectionTimeoutMs: 60_000,
} as const;
const LIMITS = JP_BANNER_INVENTORY_LIMITS;
function restrictedSummonTerms(title: string) {
  const normalized = title.normalize("NFKC");
  return ["有償", "福袋", "デスティニーオーダー", "フレンドポイント"].filter(
    (term) => normalized.includes(term),
  );
}
type Node = DefaultTreeAdapterMap["node"];
type IndexEntry = {
  sourceRecordId: string;
  url: string;
  title: string | null;
  listedDay: string | null;
  classification:
    "UNCLASSIFIED" | "SUMMON_CANDIDATE" | "RESTRICTED_SUMMON_CANDIDATE";
  inspectionStatus:
    | "NOT_INSPECTED"
    | "UNRESOLVED"
    | "INSPECTED"
    | "NOT_RELEVANT"
    | "FETCH_FAILED";
  inspection: ReturnType<typeof parseJpBannerArticle> | null;
  issues: string[];
};

function attribute(node: Node, name: string) {
  return "attrs" in node
    ? node.attrs.find((item) => item.name === name)?.value
    : undefined;
}
function hasClass(node: Node, name: string) {
  return attribute(node, "class")?.split(/\s+/).includes(name) ?? false;
}
function walk(root: Node) {
  const nodes: Node[] = [],
    stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (["script", "style", "template", "noscript"].includes(node.nodeName))
      continue;
    nodes.push(node);
    if (nodes.length > LIMITS.maxNodes)
      throw new Error("JP index node limit exceeded.");
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  return nodes;
}
function text(node: Node) {
  return walk(node)
    .flatMap((item) =>
      item.nodeName === "#text" && "value" in item ? [item.value] : [],
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function officialUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Unsupported JP source URL.");
  return url;
}
export function jpBannerIndexUrl(page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > LIMITS.maxPageNumber)
    throw new Error("Invalid JP index page.");
  return `${ORIGIN}/${page === 1 ? "" : `page/${page}/`}`;
}
function indexUrl(value: string) {
  const url = officialUrl(value);
  const page =
    url.pathname === "/"
      ? 1
      : Number(/^\/page\/([1-9]\d*)\/$/.exec(url.pathname)?.[1]);
  if (jpBannerIndexUrl(page) !== url.href)
    throw new Error("Unsupported JP index URL.");
  return url.href;
}
function articleUrl(value: string) {
  const url = officialUrl(value);
  if (
    !/^\/(?:20\d{2}\/(?:\d{2}\/)?|info\/)[A-Za-z0-9_-]+\/$/.test(
      url.pathname,
    ) ||
    url.pathname.length > 240
  )
    throw new Error("Unsupported JP article URL.");
  return url.href;
}
function calendarDate(value: string) {
  const match = /^(20\d{2})\.(\d{2})\.(\d{2})$/.exec(value);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === day
    ? day
    : null;
}

function listingDayBounds(entries: readonly { listedDay: string | null }[]) {
  const days = entries
    .flatMap((entry) => (entry.listedDay ? [entry.listedDay] : []))
    .sort();
  return {
    oldest: days[0] ?? null,
    newest: days.at(-1) ?? null,
    undatedObservations: entries.filter((entry) => !entry.listedDay).length,
  };
}

export function parseJpBannerIndex(body: string, sourceUrl: string) {
  const url = indexUrl(sourceUrl);
  if (Buffer.byteLength(body) > LIMITS.maxBodyBytes)
    throw new Error("JP index body limit exceeded.");
  const nodes = walk(parse(body));
  const lists = nodes.filter(
    (node) => node.nodeName === "ul" && hasClass(node, "list_news"),
  );
  const pagers = nodes.filter((node) => hasClass(node, "pager"));
  if (lists.length !== 1 || pagers.length !== 1)
    throw new Error("Unsupported JP index layout.");
  const list = lists[0]!;
  const cards =
    "childNodes" in list
      ? list.childNodes.filter((node) => node.nodeName === "li")
      : [];
  if (!cards.length || cards.length > LIMITS.maxEntriesPerPage)
    throw new Error("Unsupported JP index entry count.");
  const entries = cards.map((card): IndexEntry => {
    const children = walk(card);
    const links = new Set(
      children
        .filter((node) => node.nodeName === "a")
        .map((node) => {
          const href = attribute(node, "href");
          if (!href) throw new Error("Missing JP article link.");
          return articleUrl(new URL(href, url).href);
        }),
    );
    if (links.size !== 1) throw new Error("Ambiguous JP article link.");
    const titles = children.filter((node) => hasClass(node, "title"));
    const dates = children.filter((node) => hasClass(node, "date"));
    const title = titles.length === 1 ? text(titles[0]!) : "";
    if (title.length > LIMITS.maxTitleCharacters)
      throw new Error("JP index title limit exceeded.");
    const listedDay = dates.length === 1 ? calendarDate(text(dates[0]!)) : null;
    const article = [...links][0]!;
    const normalTitle = title.normalize("NFKC");
    return {
      sourceRecordId: `publisher:JP:article:${new URL(article).pathname}`,
      url: article,
      title: title || null,
      listedDay,
      // Title hints prioritize inspection; they do not establish banner coverage.
      classification: !normalTitle.includes("召喚")
        ? "UNCLASSIFIED"
        : restrictedSummonTerms(title).length
          ? "RESTRICTED_SUMMON_CANDIDATE"
          : "SUMMON_CANDIDATE",
      inspectionStatus: "NOT_INSPECTED",
      inspection: null,
      issues: [
        ...(!title ? ["TITLE_UNAVAILABLE"] : []),
        ...(!listedDay ? ["DATE_UNAVAILABLE"] : []),
      ],
    };
  });
  const pagerLinks = walk(pagers[0]!).filter((node) => node.nodeName === "a");
  for (const link of pagerLinks) {
    const label = text(link),
      href = attribute(link, "href");
    if ((!label.includes("次へ") && !label.includes("前へ")) || !href)
      throw new Error("Unsupported JP pagination label.");
    indexUrl(new URL(href, url).href);
  }
  const nextLinks = pagerLinks.filter((node) => text(node).includes("次へ"));
  if (nextLinks.length > 1) throw new Error("Ambiguous JP pagination.");
  const href = nextLinks[0] ? attribute(nextLinks[0], "href") : null;
  if (nextLinks.length && !href) throw new Error("Missing JP pagination link.");
  const nextUrl = href ? indexUrl(new URL(href, url).href) : null;
  return {
    url,
    contentHash: createHash("sha256").update(body).digest("hex"),
    entries,
    nextUrl,
  };
}

async function fetchJpHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
  parentSignal?: AbortSignal,
) {
  const signal = parentSignal
    ? AbortSignal.any([
        parentSignal,
        AbortSignal.timeout(LIMITS.requestTimeoutMs),
      ])
    : AbortSignal.timeout(LIMITS.requestTimeoutMs);
  const response = await fetchFn(url, {
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    headers: { accept: "text/html" },
    signal,
  });
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const length = Number(response.headers.get("content-length") ?? 0);
  if (
    !response.ok ||
    response.redirected ||
    type !== "text/html" ||
    !response.body ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > LIMITS.maxBodyBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Unsupported JP index response.");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "",
    bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.maxBodyBytes)
        throw new Error("JP index body limit exceeded.");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function fetchJpBannerIndex(
  url: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  return fetchJpHtml(indexUrl(url), fetchFn, signal);
}

export async function fetchJpBannerArticle(
  url: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  return fetchJpHtml(articleUrl(url), fetchFn, signal);
}

export function parseJpBannerArticle(body: string, sourceUrl: string) {
  const url = articleUrl(sourceUrl);
  if (Buffer.byteLength(body) > LIMITS.maxBodyBytes)
    throw new Error("JP article body limit exceeded.");
  const document = walk(parse(body));
  const roots = document.filter((node) => hasClass(node, "article"));
  if (roots.length !== 1) throw new Error("Unsupported JP article layout.");
  const nodes = walk(roots[0]!);
  const titles = nodes.filter((node) => hasClass(node, "title"));
  const title = titles.length === 1 ? text(titles[0]!) : "";
  const restrictionTerms =
    title.length <= LIMITS.maxTitleCharacters
      ? restrictedSummonTerms(title)
      : [];
  const reasons: string[] = [];
  if (!title) reasons.push("ARTICLE_TITLE_UNAVAILABLE");
  if (title.length > LIMITS.maxTitleCharacters)
    reasons.push("ARTICLE_TITLE_LIMIT");
  const blockText = new Map(
    nodes
      .filter((node) => ["p", "h2", "h3", "h4", "tr"].includes(node.nodeName))
      .map((node) => [node, text(node)] as const),
  );
  const blocks = [...blockText.values()].filter(Boolean);
  if (
    blocks.length > LIMITS.maxEvidenceBlocks ||
    blocks.some((block) => block.length > LIMITS.maxEvidenceCharacters)
  )
    reasons.push("ARTICLE_EVIDENCE_LIMIT");
  const evidenceBlocks = blocks
    .slice(0, LIMITS.maxEvidenceBlocks)
    .map((block) => block.slice(0, LIMITS.maxEvidenceCharacters));
  const images = nodes.filter((node) => node.nodeName === "img");
  if (images.length > LIMITS.maxImageReferences)
    reasons.push("IMAGE_REFERENCE_LIMIT");
  const imageContext = new Map<Node, string>();
  let nearbyText = "";
  for (const node of nodes) {
    const context = blockText.get(node);
    if (context) nearbyText = context.slice(0, LIMITS.maxEvidenceCharacters);
    if (node.nodeName === "img") imageContext.set(node, nearbyText);
  }
  const imageReferences: { url: string; alt: string; context: string }[] = [];
  for (const image of images.slice(0, LIMITS.maxImageReferences)) {
    const src = attribute(image, "src");
    const alt = attribute(image, "alt") ?? "";
    if (alt.length > LIMITS.maxTitleCharacters) reasons.push("IMAGE_ALT_LIMIT");
    try {
      if (!src) throw new Error("Missing image source.");
      const imageUrl = new URL(jpBannerImageUrl(new URL(src, url).href));
      if (
        !imageReferences.some(
          (reference) =>
            reference.url === imageUrl.href &&
            reference.alt === alt &&
            reference.context === imageContext.get(image),
        )
      )
        imageReferences.push({
          url: imageUrl.href,
          alt: alt.slice(0, LIMITS.maxTitleCharacters),
          context: imageContext.get(image) ?? "",
        });
    } catch {
      reasons.push("UNSUPPORTED_IMAGE_REFERENCE");
    }
  }
  const content = text(roots[0]!).normalize("NFKC");
  const hasSummonContent =
    /召喚|召唤|ガチャ|ピックアップ|summon|gacha|pick[\s-]?up/iu.test(
      `${content} ${imageReferences.map((image) => image.alt).join(" ")}`,
    );
  const hasEmbeds = nodes.some(
    (node) =>
      [
        "iframe",
        "video",
        "audio",
        "object",
        "embed",
        "canvas",
        "svg",
        "picture",
        "source",
      ].includes(node.nodeName) ||
      /url\s*\(/i.test(attribute(node, "style") ?? ""),
  );
  const linkedArticles: string[] = [];
  let hasUninterpretedLinks = false;
  for (const node of nodes.filter((node) => node.nodeName === "a")) {
    const href = attribute(node, "href");
    if (!href) continue;
    try {
      const linked = new URL(href, url);
      linked.hash = "";
      const checked = articleUrl(linked.href);
      if (checked !== url && !linkedArticles.includes(checked))
        linkedArticles.push(checked);
    } catch {
      // Unsupported links are not fetched, but their contents remain unknown.
      hasUninterpretedLinks = true;
    }
  }
  if (linkedArticles.length > LIMITS.maxLinkedArticles)
    reasons.push("LINKED_ARTICLE_LIMIT");
  if (!blocks.length && !images.length && !hasEmbeds && !linkedArticles.length)
    reasons.push("EMPTY_ARTICLE_CONTENT");
  let kind:
    | "SUMMON_CONTENT"
    | "RESTRICTED_SUMMON_CONTENT"
    | "NOT_RELEVANT"
    | "UNRESOLVED";
  if (reasons.length) kind = "UNRESOLVED";
  else if (hasSummonContent)
    kind = restrictionTerms.length
      ? "RESTRICTED_SUMMON_CONTENT"
      : "SUMMON_CONTENT";
  else if (
    !images.length &&
    !hasEmbeds &&
    !linkedArticles.length &&
    !hasUninterpretedLinks &&
    blocks.length
  ) {
    kind = "NOT_RELEVANT";
    reasons.push("TEXT_ONLY_NON_SUMMON_NOTICE");
  } else {
    kind = "UNRESOLVED";
    reasons.push(
      linkedArticles.length
        ? "LINKED_ARTICLES_UNINSPECTED"
        : hasUninterpretedLinks
          ? "UNINTERPRETED_LINK_REFERENCE"
          : images.length || hasEmbeds
            ? "NON_TEXT_CONTENT_UNINTERPRETED"
            : "EMPTY_ARTICLE_CONTENT",
    );
  }
  return {
    url,
    contentHash: createHash("sha256").update(body).digest("hex"),
    title: title ? title.slice(0, LIMITS.maxTitleCharacters) : null,
    kind,
    // Title evidence survives incomplete body extraction; absence does not prove ordinary rules.
    restrictionEvidence: restrictionTerms.length
      ? { basis: "TITLE_HINT" as const, terms: restrictionTerms }
      : null,
    reasons: [...new Set(reasons)],
    evidenceBlocks,
    imageReferences,
    linkedArticles: linkedArticles.slice(0, LIMITS.maxLinkedArticles),
    naProjection: null as ReturnType<typeof previewJpBannerProjection> | null,
    imageEvidence: null as ReturnType<typeof jpBannerImageEvidence> | null,
    servantIdentities: null as ReturnType<
      typeof resolveJpBannerServantMentions
    > | null,
    pickupEvidence: null as ReturnType<
      typeof associateJpBannerPickupEvidence
    > | null,
    schedule: extractJpBannerSchedule({
      sourceUrl: url,
      title,
      blocks: [...blockText.entries()]
        .filter(([node]) => {
          let parent = "parentNode" in node ? node.parentNode : null;
          while (parent && parent !== roots[0]) {
            if (blockText.has(parent)) return false;
            parent = "parentNode" in parent ? parent.parentNode : null;
          }
          return true;
        })
        .map(([, value]) => value)
        .filter(Boolean)
        .slice(0, LIMITS.maxEvidenceBlocks)
        .map((value) => value.slice(0, LIMITS.maxEvidenceCharacters)),
      images: imageReferences,
      summonContent: hasSummonContent,
      evidenceComplete: kind === "NOT_RELEVANT" || !reasons.length,
    }),
    publicationAllowed: false as const,
  };
}

export type JpBannerInventoryOptions = {
  startPage?: number;
  pages?: number;
  listedFrom?: string;
  listedThrough?: string;
  inspect?: number;
  resolveServants?: boolean;
  projectNa?: boolean;
  inspectImages?: number;
  articleUrls?: string[];
  followLinks?: number;
};

export async function inventoryJpBannerAnnouncements(
  options: JpBannerInventoryOptions = {},
  dependencies: { fetchFn?: typeof fetch; now?: () => Date } = {},
) {
  const pages = options.pages ?? LIMITS.defaultPages,
    startPage = options.startPage ?? 1;
  const hasInterval =
    options.listedFrom !== undefined || options.listedThrough !== undefined;
  if (
    hasInterval &&
    (typeof options.listedFrom !== "string" ||
      typeof options.listedThrough !== "string" ||
      calendarDate(options.listedFrom.replaceAll("-", ".")) !==
        options.listedFrom ||
      calendarDate(options.listedThrough.replaceAll("-", ".")) !==
        options.listedThrough ||
      options.listedFrom > options.listedThrough)
  )
    throw new Error("Invalid JP listing date interval.");
  const listingInterval = hasInterval
    ? { from: options.listedFrom!, through: options.listedThrough! }
    : null;
  if (
    options.articleUrls !== undefined &&
    (!Array.isArray(options.articleUrls) ||
      !options.articleUrls.length ||
      options.articleUrls.length > LIMITS.maxArticleInspections ||
      options.articleUrls.some((url) => typeof url !== "string"))
  )
    throw new Error("Invalid direct JP article selection.");
  const directUrls = [...new Set((options.articleUrls ?? []).map(articleUrl))];
  if (
    directUrls.length &&
    (options.pages !== undefined ||
      options.startPage !== undefined ||
      listingInterval !== null)
  )
    throw new Error(
      "Direct article selection cannot be combined with archive pages.",
    );
  const inspect = options.inspect ?? directUrls.length;
  const inspectImages = options.inspectImages ?? 0;
  if (
    !Number.isSafeInteger(inspectImages) ||
    inspectImages < 0 ||
    inspectImages > JP_BANNER_IMAGE_LIMITS.maxInspections ||
    (inspectImages > 0 && inspect === 0)
  )
    throw new Error("Invalid schedule image inspection budget.");
  const followLinks = options.followLinks ?? 0;
  if (
    !Number.isSafeInteger(followLinks) ||
    followLinks < 0 ||
    followLinks > LIMITS.maxArticleInspections ||
    (followLinks > 0 && inspect === 0) ||
    inspect + followLinks > LIMITS.maxArticleInspections
  )
    throw new Error("Invalid linked article inspection budget.");
  if (
    (options.projectNa !== undefined &&
      typeof options.projectNa !== "boolean") ||
    (options.projectNa && inspect === 0)
  )
    throw new Error("NA projection requires article inspection.");
  if (
    (options.resolveServants !== undefined &&
      typeof options.resolveServants !== "boolean") ||
    (options.resolveServants && inspect === 0)
  )
    throw new Error("Servant resolution requires article inspection.");
  if (
    !Number.isSafeInteger(inspect) ||
    inspect < 0 ||
    inspect > LIMITS.maxArticleInspections
  )
    throw new Error("Invalid JP article inspection limit.");
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > LIMITS.maxPages)
    throw new Error("Invalid JP inventory page limit.");
  let nextUrl: string | null = directUrls.length
    ? null
    : jpBannerIndexUrl(startPage);
  const retrievedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const signal = AbortSignal.timeout(LIMITS.collectionTimeoutMs);
  const indices: ReturnType<typeof parseJpBannerIndex>[] = [];
  const seen = new Set<string>();
  let failure: {
    url: string;
    code: "INDEX_FETCH_OR_PARSE_FAILED" | "PAGINATION_LOOP";
  } | null = null;
  while (nextUrl && indices.length < pages) {
    const currentUrl = nextUrl;
    if (seen.has(currentUrl)) {
      failure = { url: currentUrl, code: "PAGINATION_LOOP" };
      break;
    }
    seen.add(currentUrl);
    try {
      const parsed = parseJpBannerIndex(
        await fetchJpBannerIndex(currentUrl, dependencies.fetchFn, signal),
        currentUrl,
      );
      indices.push(parsed);
      nextUrl = parsed.nextUrl;
    } catch {
      failure = { url: currentUrl, code: "INDEX_FETCH_OR_PARSE_FAILED" };
      break;
    }
  }
  const articles = new Map<
    string,
    ReturnType<typeof parseJpBannerIndex>["entries"][number] & {
      indexUrls: string[];
      linkedFrom: string[];
      discovery: "ARCHIVE_INDEX" | "DIRECT_LOOKUP" | "LINKED_NOTICE";
    }
  >();
  for (const index of indices)
    for (const entry of index.entries) {
      const existing = articles.get(entry.url);
      if (existing) {
        if (!existing.indexUrls.includes(index.url))
          existing.indexUrls.push(index.url);
        if (
          existing.title !== entry.title ||
          existing.listedDay !== entry.listedDay
        ) {
          existing.classification = "UNCLASSIFIED";
          existing.inspectionStatus = "UNRESOLVED";
          if (!existing.issues.includes("INDEX_METADATA_CONFLICT"))
            existing.issues.push("INDEX_METADATA_CONFLICT");
        }
      } else
        articles.set(entry.url, {
          ...entry,
          indexUrls: [index.url],
          linkedFrom: [],
          discovery: "ARCHIVE_INDEX",
        });
    }
  // Filter only after merging observations: conflicting or missing dates cannot
  // safely exclude an article. Linked notices are independent source evidence.
  const outsideIntervalArticles: typeof articles = new Map();
  if (listingInterval) {
    for (const [url, entry] of articles) {
      if (
        entry.listedDay &&
        !entry.issues.includes("INDEX_METADATA_CONFLICT") &&
        (entry.listedDay < listingInterval.from ||
          entry.listedDay > listingInterval.through)
      ) {
        outsideIntervalArticles.set(url, entry);
        articles.delete(url);
      }
    }
  }
  function addUnlistedArticle(url: string, linkedFrom: string | null) {
    const archived = outsideIntervalArticles.get(url);
    if (archived && linkedFrom) {
      articles.set(url, { ...archived, linkedFrom: [linkedFrom] });
      return;
    }
    articles.set(url, {
      sourceRecordId: `publisher:JP:article:${new URL(url).pathname}`,
      url,
      title: null,
      listedDay: null,
      classification: "UNCLASSIFIED",
      inspectionStatus: "NOT_INSPECTED",
      inspection: null,
      issues: [],
      indexUrls: [],
      linkedFrom: linkedFrom ? [linkedFrom] : [],
      discovery: linkedFrom ? "LINKED_NOTICE" : "DIRECT_LOOKUP",
    });
  }
  for (const url of directUrls) addUnlistedArticle(url, null);
  const articleFailures: {
    url: string;
    code: "ARTICLE_FETCH_FAILED" | "ARTICLE_PARSE_FAILED";
  }[] = [];
  const inspectionCandidates = [...articles.values()]
    .filter((entry) => entry.inspectionStatus === "NOT_INSPECTED")
    .sort(
      (a, b) =>
        Number(a.classification === "UNCLASSIFIED") -
        Number(b.classification === "UNCLASSIFIED"),
    );
  let inspectionDeadlineReached = false;
  const inspectionQueue = inspectionCandidates
    .slice(0, inspect)
    .map((entry) => ({ entry, linked: false }));
  const queued = new Set(inspectionQueue.map(({ entry }) => entry.url));
  let queuedLinked = 0,
    attemptedLinked = 0,
    discoveredLinked = 0;
  let linkedDiscoveryLimited = false;
  for (const { entry, linked } of inspectionQueue) {
    if (signal.aborted) {
      inspectionDeadlineReached = true;
      break;
    }
    if (linked) attemptedLinked++;
    let body: string;
    try {
      body = await fetchJpBannerArticle(
        entry.url,
        dependencies.fetchFn,
        signal,
      );
    } catch {
      entry.inspectionStatus = "FETCH_FAILED";
      articleFailures.push({ url: entry.url, code: "ARTICLE_FETCH_FAILED" });
      continue;
    }
    try {
      const inspection = parseJpBannerArticle(body, entry.url);
      if (options.projectNa)
        inspection.naProjection = previewJpBannerProjection(
          inspection.schedule,
          inspection.kind,
        );
      entry.inspection = inspection;
      entry.inspectionStatus =
        inspection.kind === "UNRESOLVED"
          ? "UNRESOLVED"
          : inspection.kind === "NOT_RELEVANT"
            ? "NOT_RELEVANT"
            : "INSPECTED";
      if (followLinks > 0) {
        for (const url of inspection.linkedArticles) {
          if (!articles.has(url)) {
            if (discoveredLinked >= LIMITS.maxDiscoveredLinkedArticles) {
              linkedDiscoveryLimited = true;
              continue;
            }
            addUnlistedArticle(url, entry.url);
            discoveredLinked++;
          }
          const child = articles.get(url)!;
          if (!child.linkedFrom.includes(entry.url))
            child.linkedFrom.push(entry.url);
          if (
            !queued.has(url) &&
            child.inspectionStatus === "NOT_INSPECTED" &&
            queuedLinked < followLinks
          ) {
            queued.add(url);
            inspectionQueue.push({ entry: child, linked: true });
            queuedLinked++;
          }
        }
      }
    } catch {
      entry.inspectionStatus = "UNRESOLVED";
      articleFailures.push({
        url: entry.url,
        code: "ARTICLE_PARSE_FAILED",
      });
    }
  }
  const servantCatalogue: {
    status: "NOT_REQUESTED" | "NO_NAME_MENTIONS" | "SUCCEEDED" | "FAILED";
    sourceUrl: string;
    contentHash: string | null;
    error: "SERVANT_CATALOGUE_FETCH_OR_PARSE_FAILED" | null;
  } = {
    status: "NOT_REQUESTED",
    sourceUrl: JP_BANNER_SERVANT_SOURCE,
    contentHash: null,
    error: null,
  };
  if (options.resolveServants) {
    const inspections = [...articles.values()].flatMap((entry) =>
      entry.inspection?.schedule.servantMentions.length
        ? [entry.inspection]
        : [],
    );
    if (!inspections.length) servantCatalogue.status = "NO_NAME_MENTIONS";
    else {
      try {
        const catalogue = await fetchJpBannerServantCatalogue(
          dependencies.fetchFn,
          signal,
        );
        const resolutions = inspections.map((inspection) => {
          const matches = resolveJpBannerServantMentions(
            inspection.schedule.servantMentions,
            catalogue.servants,
          );
          return {
            inspection,
            matches,
            pickupEvidence: associateJpBannerPickupEvidence(
              inspection.schedule,
              matches,
              inspection.kind,
            ),
          };
        });
        for (const { inspection, matches, pickupEvidence } of resolutions) {
          inspection.servantIdentities = matches;
          inspection.pickupEvidence = pickupEvidence;
        }
        servantCatalogue.status = "SUCCEEDED";
        servantCatalogue.contentHash = catalogue.contentHash;
      } catch {
        servantCatalogue.status = "FAILED";
        servantCatalogue.error = "SERVANT_CATALOGUE_FETCH_OR_PARSE_FAILED";
      }
    }
  }
  const imageCandidates = [
    ...new Set(
      [...articles.values()].flatMap(
        (entry) =>
          entry.inspection?.schedule.scheduleImageCandidates.map(
            (image) => image.url,
          ) ?? [],
      ),
    ),
  ];
  const imageResults = new Map<
    string,
    Awaited<ReturnType<typeof inspectJpBannerImage>> | null
  >();
  let imageFailures = 0;
  if (inspectImages > 0) {
    for (const url of imageCandidates.slice(0, inspectImages)) {
      if (signal.aborted) break;
      try {
        imageResults.set(
          url,
          await inspectJpBannerImage(url, dependencies.fetchFn, signal),
        );
      } catch {
        imageResults.set(url, null);
        imageFailures++;
      }
    }
    for (const entry of articles.values()) {
      if (entry.inspection)
        entry.inspection.imageEvidence = jpBannerImageEvidence(
          entry.inspection.contentHash,
          entry.inspection.schedule.scheduleImageCandidates,
          imageResults,
        );
    }
  }
  const uninspectedLinked = [...articles.values()].some(
    (entry) =>
      entry.linkedFrom.length > 0 && entry.inspectionStatus === "NOT_INSPECTED",
  );
  const linkedInspectionLimited =
    followLinks > 0 && (linkedDiscoveryLimited || uninspectedLinked);
  const selectedArticles = [...articles.values()];
  const nextPage = startPage + indices.length;
  const contiguousPages =
    indices.every(
      (index, offset) =>
        startPage + offset <= LIMITS.maxPageNumber &&
        index.url === jpBannerIndexUrl(startPage + offset),
    ) &&
    (!nextUrl ||
      (nextPage <= LIMITS.maxPageNumber &&
        nextUrl === jpBannerIndexUrl(nextPage)));
  const archiveTraversed =
    !directUrls.length &&
    indices.length > 0 &&
    startPage === 1 &&
    !failure &&
    !nextUrl &&
    contiguousPages;
  const inspectionStates = {
    NOT_INSPECTED: 0,
    UNRESOLVED: 0,
    INSPECTED: 0,
    NOT_RELEVANT: 0,
    FETCH_FAILED: 0,
  };
  const contentKinds = {
    SUMMON_CONTENT: 0,
    RESTRICTED_SUMMON_CONTENT: 0,
    NOT_RELEVANT: 0,
    UNRESOLVED: 0,
  };
  for (const entry of selectedArticles) {
    inspectionStates[entry.inspectionStatus]++;
    if (entry.inspection) contentKinds[entry.inspection.kind]++;
  }
  const continuationPage =
    nextUrl && !failure && contiguousPages ? startPage + indices.length : null;
  return {
    scope: directUrls.length
      ? ("DIRECT_JP_ARTICLE_SELECTION" as const)
      : ("BOUNDED_JP_NEWS_ARCHIVE" as const),
    status:
      failure ||
      !contiguousPages ||
      articleFailures.length ||
      inspectionDeadlineReached ||
      servantCatalogue.status === "FAILED" ||
      imageFailures > 0 ||
      (inspectImages > 0 &&
        signal.aborted &&
        imageResults.size < Math.min(inspectImages, imageCandidates.length))
        ? ("partial_failure" as const)
        : ("succeeded" as const),
    publicationAllowed: false as const,
    retrievedAt,
    startPage: directUrls.length ? null : startPage,
    requestedPages: directUrls.length ? 0 : pages,
    listingSelection: {
      interval: listingInterval,
      basis: "JP_ARCHIVE_LISTING_DAY" as const,
      inclusive: true as const,
      outsideInterval: outsideIntervalArticles.size,
      outsideIntervalLinkedExceptions: [
        ...outsideIntervalArticles.keys(),
      ].filter((url) => articles.has(url)).length,
      unknownOrConflictingDate: [...articles.values()].filter(
        (entry) =>
          entry.discovery === "ARCHIVE_INDEX" &&
          (!entry.listedDay ||
            entry.issues.includes("INDEX_METADATA_CONFLICT")),
      ).length,
      linkedNoticesDateFiltered: false as const,
    },
    discoveryCoverage: {
      requestedListingInterval: listingInterval,
      dateBasis: "JP_ARCHIVE_LISTING_DAY" as const,
      observedListingDays: listingDayBounds(
        indices.flatMap((index) => index.entries),
      ),
      archiveTraversal: directUrls.length
        ? "NOT_REQUESTED"
        : archiveTraversed
          ? "OBSERVED_ARCHIVE_TRAVERSED"
          : "INCOMPLETE",
      traversalReasons: [
        ...(directUrls.length ? ["DIRECT_SELECTION"] : []),
        ...(!directUrls.length && startPage !== 1
          ? ["EARLIER_PAGES_NOT_READ"]
          : []),
        ...(failure ? [failure.code] : []),
        ...(!contiguousPages ? ["NON_CONTIGUOUS_PAGINATION"] : []),
        ...(nextUrl && !failure && contiguousPages
          ? ["PAGE_BUDGET_REACHED"]
          : []),
      ],
      pagesRead: indices.length,
      archiveContinuation: continuationPage
        ? {
            startPage: continuationPage,
            pages,
            ...(listingInterval
              ? {
                  listedFrom: listingInterval.from,
                  listedThrough: listingInterval.through,
                }
              : {}),
          }
        : null,
      continuationScope:
        "ARCHIVE_DISCOVERY_ONLY_NOT_ARTICLE_RETRY_OR_SNAPSHOT" as const,
      snapshotConsistency: "NOT_VERIFIED" as const,
      dateBoundsProveCoverage: false as const,
      completeBannerCoverage: false as const,
      selectedArticles: {
        total: selectedArticles.length,
        byInspectionStatus: inspectionStates,
        byInspectedContentKind: contentKinds,
        unknownContent:
          selectedArticles.length -
          selectedArticles.filter((entry) => entry.inspection).length,
        pendingScheduleEvidence: selectedArticles.filter(
          (entry) =>
            (entry.inspection?.schedule.pendingEvidence.length ?? 0) > 0,
        ).length,
        linkedSourcesNotInspected: selectedArticles.filter(
          (entry) =>
            entry.linkedFrom.length > 0 &&
            entry.inspectionStatus === "NOT_INSPECTED",
        ).length,
        sourcesWithUntraversedLinks: selectedArticles.filter((entry) =>
          entry.inspection?.linkedArticles.some(
            (url) => !articles.get(url)?.inspection,
          ),
        ).length,
      },
    },
    coverageLimited:
      directUrls.length > 0 ||
      startPage !== 1 ||
      nextUrl !== null ||
      failure !== null ||
      !contiguousPages ||
      linkedInspectionLimited,
    stopReason: directUrls.length
      ? "EXPLICIT_ARTICLES"
      : (failure?.code ??
        (!contiguousPages
          ? "NON_CONTIGUOUS_PAGINATION"
          : nextUrl
            ? "PAGE_LIMIT"
            : "ARCHIVE_END")),
    nextIndexUrl: nextUrl,
    failure,
    articleFailures,
    servantCatalogue,
    scheduleImages: {
      status:
        inspectImages === 0
          ? "NOT_REQUESTED"
          : !imageCandidates.length
            ? "NO_CANDIDATES"
            : imageFailures
              ? "PARTIAL_FAILURE"
              : imageResults.size < imageCandidates.length
                ? "LIMITED"
                : "SUCCEEDED",
      requestedInspections: inspectImages,
      discoveredCandidates: imageCandidates.length,
      attempted: imageResults.size,
      failed: imageFailures,
      notInspected: imageCandidates.length - imageResults.size,
      deadlineReached: inspectImages > 0 && signal.aborted,
      interpretation: "UNINTERPRETED" as const,
    },
    linkedTraversal: {
      requestedInspections: followLinks,
      attemptedInspections: attemptedLinked,
      discoveredArticles: discoveredLinked,
      discoveryLimited: linkedDiscoveryLimited,
      inspectionLimited: linkedInspectionLimited,
      stopReason:
        followLinks === 0
          ? "NOT_REQUESTED"
          : inspectionDeadlineReached
            ? "DEADLINE"
            : linkedDiscoveryLimited
              ? "DISCOVERY_LIMIT"
              : uninspectedLinked
                ? "ARTICLE_LIMIT"
                : "ELIGIBLE_LINKS_ATTEMPTED",
    },
    requestedArticleInspections: inspect,
    inspectionStopReason:
      inspect === 0
        ? "NOT_REQUESTED"
        : inspectionDeadlineReached
          ? "DEADLINE"
          : inspectionCandidates.length > inspect
            ? "ARTICLE_LIMIT"
            : "ELIGIBLE_ARTICLES_ATTEMPTED",
    inspectionLimited:
      inspect > 0 &&
      [...articles.values()].some(
        (entry) => entry.inspectionStatus === "NOT_INSPECTED",
      ),
    indices: indices.map(({ url, contentHash, entries, nextUrl }) => ({
      url,
      contentHash,
      entries: entries.length,
      ...listingDayBounds(entries),
      nextUrl,
    })),
    counts: {
      discoveredArticles: articles.size,
      summonCandidates: [...articles.values()].filter(
        (entry) => entry.classification === "SUMMON_CANDIDATE",
      ).length,
      restrictedSummonCandidates: [...articles.values()].filter(
        (entry) => entry.classification === "RESTRICTED_SUMMON_CANDIDATE",
      ).length,
      unclassified: [...articles.values()].filter(
        (entry) => entry.classification === "UNCLASSIFIED",
      ).length,
      awaitingArticleInspection: [...articles.values()].filter(
        (entry) => entry.inspectionStatus === "NOT_INSPECTED",
      ).length,
      unresolved: [...articles.values()].filter(
        (entry) => entry.inspectionStatus === "UNRESOLVED",
      ).length,
      indexMetadataIssues: [...articles.values()].reduce(
        (count, entry) => count + entry.issues.length,
        0,
      ),
      inspectedArticles: [...articles.values()].filter(
        (entry) => entry.inspection !== null,
      ).length,
      notRelevant: [...articles.values()].filter(
        (entry) => entry.inspectionStatus === "NOT_RELEVANT",
      ).length,
      failedArticleInspections: articleFailures.length,
      projectedPeriodCandidates: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.naProjection?.windows.filter(
            (window) => window.status === "PROJECTED",
          ).length ?? 0),
        0,
      ),
      matchedServantNameMentions: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.servantIdentities?.filter(
            (mention) => mention.status === "MATCHED",
          ).length ?? 0),
        0,
      ),
      pickupPeriodsWithNameAssociations: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.pickupEvidence?.windows.filter(
            (window) => window.associations.length > 0,
          ).length ?? 0),
        0,
      ),
      unresolvedServantNameMentions: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.servantIdentities?.filter(
            (mention) => mention.status !== "MATCHED",
          ).length ?? 0),
        0,
      ),
      extractedPeriodCandidates: [...articles.values()].reduce(
        (count, entry) =>
          count + (entry.inspection?.schedule.periods.length ?? 0),
        0,
      ),
      timedSummonPeriodCandidates: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.schedule.periods.filter(
            (period) =>
              ["ARTICLE_ENVELOPE", "LABELLED_SUMMON"].includes(period.scope) &&
              !period.issues.length &&
              period.startsAt !== null &&
              period.endsAt !== null,
          ).length ?? 0),
        0,
      ),
      articlesAwaitingScheduleEvidence: [...articles.values()].filter(
        (entry) => (entry.inspection?.schedule.pendingEvidence.length ?? 0) > 0,
      ).length,
      parsedBanners: 0,
      publishedBanners: 0,
    },
    articles: [...articles.values()],
  };
}
