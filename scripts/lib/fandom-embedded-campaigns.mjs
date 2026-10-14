import { extractFandomRewardSources } from "./fandom-campaign-adapter.mjs";
import { extractNestedTemplates, transcludedPageTitles } from "./wikitext.mjs";

const MAX_EMBEDDED_PAGES = 24;
const MAX_EMBEDDED_DEPTH = 2;
const SUPPLEMENT_TYPES = new Set(["LOGIN_BONUS", "MANA_PRISM_EXCHANGE"]);

/** @typedef {{pageId: number, title: string, wikitext: string, url: string, contentHash: string}} EmbeddedPage */

/** Follow only explicitly embedded children of this article, not arbitrary links.
 * @param {EmbeddedPage} page
 * @param {Record<string, any>} event
 * @param {(titles: string[]) => Promise<EmbeddedPage[]>} fetchRevisions
 * @param {string} retrievedAt
 * @param {Set<string>} [independentTitles]
 */
export async function embeddedCampaignRewards(
  page,
  event,
  fetchRevisions,
  retrievedAt,
  independentTitles = new Set(),
) {
  const seen = new Set([page.title]);
  const separateCampaigns = new Set(
    [...independentTitles].filter((title) =>
      title.startsWith(`${page.title}/`),
    ),
  );
  /** @param {string} title */
  const belongsToParent = (title) =>
    title.startsWith(`${page.title}/`) &&
    ![...separateCampaigns].some(
      (boundary) => title === boundary || title.startsWith(`${boundary}/`),
    );
  let frontier = [page];
  /** @type {EmbeddedPage[]} */
  const pages = [];
  const issues = [];
  for (let depth = 0; depth < MAX_EMBEDDED_DEPTH; depth++) {
    const titles = [
      ...new Set(
        frontier.flatMap((parent) => transcludedPageTitles(parent.wikitext)),
      ),
    ].filter((title) => belongsToParent(title) && !seen.has(title));
    if (seen.size - 1 + titles.length > MAX_EMBEDDED_PAGES) {
      issues.push({
        sourceKey: `fandom:JP:page:${page.pageId}:embedded-limit`,
        severity: "WARNING",
        message: `${page.title}: embedded campaign page limit exceeded; remaining pages were not parsed.`,
      });
      break;
    }
    if (!titles.length) break;
    titles.forEach((title) => seen.add(title));
    const fetched = (await fetchRevisions(titles)).filter((child) =>
      child.title.startsWith(`${page.title}/`),
    );
    for (const child of fetched) {
      if (extractNestedTemplates(child.wikitext, "EventHeaderJP").length)
        separateCampaigns.add(child.title);
    }
    frontier = fetched.filter((child) => belongsToParent(child.title));
    for (const title of titles) {
      if (!fetched.some((child) => child.title === title)) {
        issues.push({
          sourceKey: `fandom:JP:page:${page.pageId}:embedded-missing:${encodeURIComponent(title)}`,
          severity: "WARNING",
          message: `${page.title}: embedded page ${title} was unavailable; its rewards were not inferred.`,
        });
      }
    }
    pages.push(...frontier);
  }
  const deeperTitles = frontier
    .flatMap((parent) => transcludedPageTitles(parent.wikitext))
    .filter((title) => belongsToParent(title) && !seen.has(title));
  if (
    deeperTitles.length &&
    !issues.some((issue) => issue.sourceKey.endsWith(":embedded-limit"))
  ) {
    issues.push({
      sourceKey: `fandom:JP:page:${page.pageId}:embedded-depth`,
      severity: "WARNING",
      message: `${page.title}: embedded campaign depth limit reached; deeper pages were not parsed.`,
    });
  }
  const ownedPages = pages.filter((child) => belongsToParent(child.title));
  const rewards = ownedPages.flatMap((child) => {
    const result = extractFandomRewardSources(child.wikitext, {
      pageId: child.pageId,
      eventName: page.title,
      eventSourceStartsAt: event.sourceStartsAt,
      eventSourceEndsAt: event.sourceEndsAt,
      eventSourceKey: event.sourceKey,
      evidenceSourceKey: `fandom:JP:page:${child.pageId}`,
      evidenceUrl: child.url,
      eventEndsAt: event.endsAt,
      tableCaptions: true,
    });
    issues.push(...result.issues);
    return result.rewardSources.filter((source) =>
      SUPPLEMENT_TYPES.has(source.type),
    );
  });
  return {
    pages: ownedPages,
    rewardSources: rewards,
    issues,
    sources: ownedPages.map((child) => ({
      sourceKey: `fandom:JP:page:${child.pageId}`,
      type: "WIKI",
      region: "JP",
      url: child.url,
      retrievedAt,
      contentHash: child.contentHash,
    })),
  };
}
