import { createHash } from "node:crypto";

import { z } from "zod";

export const FANDOM_API_URL = "https://fategrandorder.fandom.com/api.php";

/**
 * @typedef {{
 *   pageId: number,
 *   title: string,
 *   revisionId: number,
 *   revisionTimestamp: string,
 *   wikitext: string,
 *   contentHash: string,
 *   url: string,
 *   aliases?: string[],
 * }} FandomRevisionPage
 */

const revisionResponseSchema = z.object({
  query: z.object({
    normalized: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .optional(),
    redirects: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .optional(),
    pages: z.array(
      z
        .object({
          pageid: z.number().int().positive().optional(),
          title: z.string().min(1),
          revisions: z
            .array(
              z.object({
                revid: z.number().int().positive(),
                timestamp: z.string().datetime(),
                slots: z.object({
                  main: z.object({ content: z.string() }).passthrough(),
                }),
              }),
            )
            .min(1)
            .optional(),
          missing: z.boolean().optional(),
        })
        .passthrough(),
    ),
  }),
});

const categoryResponseSchema = z.object({
  query: z.object({
    categorymembers: z.array(
      z.object({
        pageid: z.number().int().positive(),
        ns: z.number().int(),
        title: z.string().min(1),
      }),
    ),
  }),
  continue: z
    .object({
      cmcontinue: z.string().min(1),
    })
    .passthrough()
    .optional(),
});

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} url
 * @param {{attempts?: number, fetchFn?: typeof fetch, delayFn?: (milliseconds: number) => Promise<void>, timeoutSignal?: () => AbortSignal | undefined}} options
 */
async function fetchJsonWithRetry(url, options) {
  const attempts = options.attempts ?? 3;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const delayFn =
    options.delayFn ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutSignal =
    options.timeoutSignal ?? (() => AbortSignal.timeout(60_000));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(),
      });
      if (!response.ok) {
        throw new Error(`Fandom returned HTTP ${response.status}.`);
      }
      return JSON.parse(await response.text());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delayFn(attempt * 1_000);
    }
  }

  throw new Error(`Fandom retrieval failed: ${message(lastError)}`, {
    cause: lastError,
  });
}

/** @param {string[]} titles */
export function fandomRevisionUrl(titles) {
  const parameters = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "ids|timestamp|content",
    rvslots: "main",
    titles: titles.join("|"),
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  return `${FANDOM_API_URL}?${parameters}`;
}

/** @param {string} category @param {string | null} continuation */
export function fandomCategoryUrl(category, continuation = null) {
  const parameters = new URLSearchParams({
    action: "query",
    list: "categorymembers",
    cmtitle: `Category:${category}`,
    cmlimit: "500",
    cmnamespace: "0",
    format: "json",
    formatversion: "2",
  });
  if (continuation) parameters.set("cmcontinue", continuation);
  return `${FANDOM_API_URL}?${parameters}`;
}

/**
 * @param {string} category
 * @param {{attempts?: number, fetchFn?: typeof fetch, delayFn?: (milliseconds: number) => Promise<void>, timeoutSignal?: () => AbortSignal | undefined}} [options]
 */
export async function fetchFandomCategoryMembers(category, options = {}) {
  const members = [];
  let continuation = null;
  do {
    const value = await fetchJsonWithRetry(
      fandomCategoryUrl(category, continuation),
      options,
    );
    let parsed;
    try {
      parsed = categoryResponseSchema.parse(value);
    } catch (error) {
      throw new Error("Fandom returned an invalid category response.", {
        cause: error,
      });
    }
    members.push(...parsed.query.categorymembers);
    continuation = parsed.continue?.cmcontinue ?? null;
  } while (continuation);
  return members;
}

/**
 * @param {string[]} titles
 * @param {{attempts?: number, fetchFn?: typeof fetch, delayFn?: (milliseconds: number) => Promise<void>, timeoutSignal?: () => AbortSignal | undefined}} [options]
 * @returns {Promise<FandomRevisionPage[]>}
 */
export async function fetchFandomRevisions(titles, options = {}) {
  if (titles.length === 0) return [];
  if (titles.length > 50) {
    throw new Error(
      "A Fandom revision request cannot contain more than 50 titles.",
    );
  }

  const value = await fetchJsonWithRetry(fandomRevisionUrl(titles), options);
  let parsed;
  try {
    parsed = revisionResponseSchema.parse(value);
  } catch (error) {
    throw new Error("Fandom returned an invalid revision response.", {
      cause: error,
    });
  }

  return parsed.query.pages.flatMap((page) => {
    const revision = page.revisions?.[0];
    if (!page.pageid || !revision) return [];
    const wikitext = revision.slots.main.content;
    const titleAliases = new Map(
      /** @type {Array<[string, string]>} */ ([
        ...(parsed.query.normalized ?? []).map(
          ({ from, to }) => /** @type {[string, string]} */ ([from, to]),
        ),
        ...(parsed.query.redirects ?? []).map(
          ({ from, to }) => /** @type {[string, string]} */ ([from, to]),
        ),
      ]),
    );
    const resolvesToPage = (/** @type {string} */ title) => {
      const visited = new Set();
      let resolved = title;
      while (titleAliases.has(resolved) && !visited.has(resolved)) {
        visited.add(resolved);
        resolved = titleAliases.get(resolved) ?? resolved;
      }
      return resolved === page.title;
    };
    return [
      {
        pageId: page.pageid,
        title: page.title,
        revisionId: revision.revid,
        revisionTimestamp: revision.timestamp,
        wikitext,
        contentHash: `sha256:${createHash("sha256").update(wikitext).digest("hex")}`,
        url: `https://fategrandorder.fandom.com/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
        aliases: [...titleAliases.keys()].filter(resolvesToPage),
      },
    ];
  });
}

/**
 * @param {string[]} titles
 * @param {Parameters<typeof fetchFandomRevisions>[1]} [options]
 * @returns {Promise<FandomRevisionPage[]>}
 */
export async function fetchAllFandomRevisions(titles, options = {}) {
  const unique = [...new Set(titles)];
  const pages = [];
  for (let index = 0; index < unique.length; index += 50) {
    pages.push(
      ...(await fetchFandomRevisions(unique.slice(index, index + 50), options)),
    );
  }
  return pages;
}
