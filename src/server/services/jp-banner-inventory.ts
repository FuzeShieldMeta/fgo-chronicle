import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { extractJpBannerSchedule } from "./jp-banner-schedule";
import {
  fetchJpBannerServantCatalogue,
  resolveJpBannerServantMentions,
  JP_BANNER_SERVANT_SOURCE,
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
  maxEvidenceBlocks: 80,
  maxEvidenceCharacters: 4_000,
  maxImageReferences: 100,
  maxLinkedArticles: 100,
  requestTimeoutMs: 15_000,
  collectionTimeoutMs: 60_000,
} as const;
const LIMITS = JP_BANNER_INVENTORY_LIMITS;
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
        : /有償|福袋|デスティニーオーダー|フレンドポイント/.test(normalTitle)
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
      const imageUrl = officialUrl(new URL(src, url).href);
      if (
        !imageUrl.pathname.startsWith("/wp-content/uploads/") ||
        !/\.(png|jpe?g|gif|webp)$/i.test(imageUrl.pathname)
      )
        throw new Error("Unsupported image source.");
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
    kind = /有償|福袋|デスティニーオーダー|フレンドポイント/.test(
      title.normalize("NFKC"),
    )
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
    reasons: [...new Set(reasons)],
    evidenceBlocks,
    imageReferences,
    linkedArticles: linkedArticles.slice(0, LIMITS.maxLinkedArticles),
    servantIdentities: null as ReturnType<
      typeof resolveJpBannerServantMentions
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

export async function inventoryJpBannerAnnouncements(
  options: {
    startPage?: number;
    pages?: number;
    inspect?: number;
    resolveServants?: boolean;
  } = {},
  dependencies: { fetchFn?: typeof fetch; now?: () => Date } = {},
) {
  const pages = options.pages ?? LIMITS.defaultPages,
    startPage = options.startPage ?? 1;
  const inspect = options.inspect ?? 0;
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
  let nextUrl: string | null = jpBannerIndexUrl(startPage);
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
      } else articles.set(entry.url, { ...entry, indexUrls: [index.url] });
    }
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
  for (const entry of inspectionCandidates.slice(0, inspect)) {
    if (signal.aborted) {
      inspectionDeadlineReached = true;
      break;
    }
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
      entry.inspection = inspection;
      entry.inspectionStatus =
        inspection.kind === "UNRESOLVED"
          ? "UNRESOLVED"
          : inspection.kind === "NOT_RELEVANT"
            ? "NOT_RELEVANT"
            : "INSPECTED";
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
        const resolutions = inspections.map((inspection) => ({
          inspection,
          matches: resolveJpBannerServantMentions(
            inspection.schedule.servantMentions,
            catalogue.servants,
          ),
        }));
        for (const { inspection, matches } of resolutions)
          inspection.servantIdentities = matches;
        servantCatalogue.status = "SUCCEEDED";
        servantCatalogue.contentHash = catalogue.contentHash;
      } catch {
        servantCatalogue.status = "FAILED";
        servantCatalogue.error = "SERVANT_CATALOGUE_FETCH_OR_PARSE_FAILED";
      }
    }
  }
  return {
    scope: "BOUNDED_JP_NEWS_ARCHIVE" as const,
    status:
      failure ||
      articleFailures.length ||
      inspectionDeadlineReached ||
      servantCatalogue.status === "FAILED"
        ? ("partial_failure" as const)
        : ("succeeded" as const),
    publicationAllowed: false as const,
    retrievedAt,
    startPage,
    requestedPages: pages,
    coverageLimited: startPage !== 1 || nextUrl !== null || failure !== null,
    stopReason: failure?.code ?? (nextUrl ? "PAGE_LIMIT" : "ARCHIVE_END"),
    nextIndexUrl: nextUrl,
    failure,
    articleFailures,
    servantCatalogue,
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
      matchedServantNameMentions: [...articles.values()].reduce(
        (count, entry) =>
          count +
          (entry.inspection?.servantIdentities?.filter(
            (mention) => mention.status === "MATCHED",
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
