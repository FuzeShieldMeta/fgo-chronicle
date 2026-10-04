import { GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS } from "~/shared/global-reconciliation-config";
import {
  discoverPublisherArticles,
  parsePublisherAnnouncement,
  publisherArticleUrl,
  publisherIndexUrl,
  PUBLISHER_ORIGIN,
} from "./global-announcement-parser";

export const PUBLISHER_FEEDS = [
  `${PUBLISHER_ORIGIN}/`,
  `${PUBLISHER_ORIGIN}/maintenance/`,
] as const;

export async function fetchPublisherHtml(
  url: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
) {
  // Only fixed publisher indices and dated articles are supported. Redirects are not followed.
  try {
    publisherArticleUrl(url);
  } catch {
    publisherIndexUrl(url);
  }
  const signal = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(LIMITS.fetchTimeoutMs),
      ])
    : AbortSignal.timeout(LIMITS.fetchTimeoutMs);
  const response = await (options.fetchFn ?? fetch)(url, {
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
) {
  const signal = AbortSignal.timeout(LIMITS.collectionTimeoutMs);
  const articleUrls = new Set<string>();
  const visited = new Set<string>();
  let coverageLimited = false;
  const perFeedLimit = Math.floor(LIMITS.maxArticles / PUBLISHER_FEEDS.length);
  for (const feed of PUBLISHER_FEEDS) {
    let feedArticles = 0;
    let next: string | null = feed;
    for (let page = 0; next && page < LIMITS.maxIndexPages; page++) {
      if (visited.has(next)) break;
      visited.add(next);
      const body = await fetchPublisherHtml(next, { ...dependencies, signal });
      const discovered = discoverPublisherArticles(body, next);
      for (const url of discovered.articleUrls) {
        if (
          feedArticles >= perFeedLimit ||
          articleUrls.size >= LIMITS.maxArticles
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
        articleUrls.size >= LIMITS.maxArticles
      ) {
        coverageLimited = true;
        break;
      }
    }
    if (next) coverageLimited = true;
  }
  const articles: ReturnType<typeof parsePublisherAnnouncement>[] = [];
  for (const url of articleUrls) {
    const body = await fetchPublisherHtml(url, { ...dependencies, signal });
    articles.push(
      parsePublisherAnnouncement(
        body,
        url,
        (dependencies.now ?? (() => new Date()))(),
      ),
    );
  }
  return {
    articles,
    coverageLimited,
    publicationAllowed: false as const,
  };
}
