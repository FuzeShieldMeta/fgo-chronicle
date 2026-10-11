import {
  GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS,
  GLOBAL_ANNOUNCEMENT_BACKFILL_LIMITS as BACKFILL,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import {
  discoverPublisherArticles,
  parsePublisherAnnouncement,
  publisherArticleUrl,
  publisherIndexUrl,
  PUBLISHER_ORIGIN,
} from "./global-announcement-parser";
import {
  parseOfficialMissionRows,
  type OfficialMissionRow,
} from "./global-mission-periods";

export type PublisherArticle = ReturnType<typeof parsePublisherAnnouncement> & {
  missions?: OfficialMissionRow[];
};

export const PUBLISHER_FEEDS = [
  `${PUBLISHER_ORIGIN}/`,
  `${PUBLISHER_ORIGIN}/maintenance/`,
] as const;

export function validateAnnouncementBackfillDays(days: number | undefined) {
  if (
    days !== undefined &&
    (!Number.isSafeInteger(days) || days < 1 || days > BACKFILL.maxDays)
  )
    throw new Error(
      `Announcement backfill must be from 1 through ${BACKFILL.maxDays} days.`,
    );
  return days;
}

function articleDate(url: string) {
  const match = /^\/(\d{4})\/(\d{2})(\d{2})(?:_|-)/.exec(new URL(url).pathname);
  if (!match) return null;
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

export async function fetchPublisherHtml(
  url: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
) {
  // Only fixed publisher indices and dated articles are supported. Redirects are not followed.
  let retrievalUrl: string;
  try {
    retrievalUrl = publisherArticleUrl(url);
  } catch {
    retrievalUrl = publisherIndexUrl(url);
  }
  const signal = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(LIMITS.fetchTimeoutMs),
      ])
    : AbortSignal.timeout(LIMITS.fetchTimeoutMs);
  const response = await (options.fetchFn ?? fetch)(retrievalUrl, {
    headers: { accept: "text/html" },
    redirect: "manual",
    signal,
    credentials: "omit",
    cache: "no-store",
  });
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (
    !response.ok ||
    response.redirected ||
    !["text/html", "application/xhtml+xml"].includes(contentType ?? "") ||
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0 ||
    declaredBytes > LIMITS.maxBodyBytes ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("The publisher returned an unsupported response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.maxBodyBytes)
        throw new Error("The publisher response exceeds the body limit.");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function loadPublisherAnnouncements(
  dependencies: { fetchFn?: typeof fetch; now?: () => Date } = {},
  options: { backfillDays?: number; asOf?: Date } = {},
) {
  const days = validateAnnouncementBackfillDays(options.backfillDays);
  const limits = days === undefined ? LIMITS : BACKFILL;
  const asOf = options.asOf ?? (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(asOf.getTime()))
    throw new Error("Invalid announcement collection date.");
  const endDay = Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
  );
  const cutoff =
    days === undefined ? null : endDay - days * MILLISECONDS_PER_DAY;
  const signal = AbortSignal.timeout(limits.collectionTimeoutMs);
  const articleUrls = new Set<string>();
  const visited = new Set<string>();
  let coverageLimited = false;
  const perFeedLimit = Math.floor(limits.maxArticles / PUBLISHER_FEEDS.length);
  for (const feed of PUBLISHER_FEEDS) {
    let feedArticles = 0;
    let next: string | null = feed;
    for (let page = 0; next && page < limits.maxIndexPages; page++) {
      if (visited.has(next)) break;
      visited.add(next);
      const body = await fetchPublisherHtml(next, { ...dependencies, signal });
      const discovered = discoverPublisherArticles(body, next);
      for (const url of discovered.articleUrls) {
        if (articleUrls.has(url)) continue;
        if (cutoff !== null) {
          const published = articleDate(url);
          // Unknown path dates are not proof that the article is outside the window.
          if (published === null) coverageLimited = true;
          else if (published < cutoff || published > endDay) continue;
        }
        if (
          feedArticles >= perFeedLimit ||
          articleUrls.size >= limits.maxArticles
        ) {
          coverageLimited = true;
          break;
        }
        articleUrls.add(url);
        feedArticles++;
      }
      next = discovered.nextUrl;
      if (
        feedArticles >= perFeedLimit ||
        articleUrls.size >= limits.maxArticles
      ) {
        coverageLimited = true;
        break;
      }
    }
    if (next) coverageLimited = true;
  }
  const articles: PublisherArticle[] = [];
  for (const url of articleUrls) {
    const body = await fetchPublisherHtml(url, { ...dependencies, signal });
    articles.push({
      ...parsePublisherAnnouncement(
        body,
        url,
        (dependencies.now ?? (() => new Date()))(),
      ),
      missions: parseOfficialMissionRows(body, url),
    });
  }
  return {
    articles,
    coverageLimited,
    publicationAllowed: false as const,
  };
}
