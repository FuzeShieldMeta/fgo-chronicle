import { parseEventDataset } from "./event-dataset.mjs";
import {
  compareFandomWithAtlas,
  classifyFandomScheduleEntry,
  parseFandomPastEventList,
  parseFandomUpcomingEvents,
} from "./fandom-event-list.mjs";
import {
  extractFandomQuestParameterRewards,
  normaliseFandomCampaign,
  parseFandomEventHeader,
} from "./fandom-campaign-adapter.mjs";
import { inferAtlasEventWarAssociations } from "./atlas-event-war-association.mjs";
import { associateFandomWarRewards } from "./atlas-war-association.mjs";
import {
  fetchAllFandomRevisions,
  fetchFandomCategoryMembers,
} from "./fandom-source.mjs";
import {
  addCalendarYears,
  classifyAtlasScheduleEvent,
  selectRollingJpEvents,
} from "./jp-event-sync.mjs";
import {
  extractTemplates,
  normaliseScheduleName,
  parseTemplateParameters,
  plainWikitext,
  stableSlug,
} from "./wikitext.mjs";

export const FANDOM_UPCOMING_TITLE = "Event List (US)/Upcoming Events";
const TITLE_ALIAS_MINIMUM_SIMILARITY = 0.6;
const TITLE_ALIAS_MINIMUM_SHARED_TOKENS = 2;
const TITLE_ALIAS_IGNORED_TOKENS = new Set([
  "arc",
  "campaign",
  "chapter",
  "event",
  "release",
  "the",
]);
const ARCHIVE_UMBRELLA_PREFIX = /^[^:\n]+:\s*/;

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
 * }} FandomPage
 */

/** @param {FandomPage[]} pages */
function indexPagesByTitle(pages) {
  return new Map(
    pages.flatMap((page) =>
      [page.title, ...(page.aliases ?? [])].map((title) => [
        normaliseScheduleName(title),
        page,
      ]),
    ),
  );
}

/** @param {number} year */
export function fandomYearTitle(year) {
  return `Event List/${year} Events`;
}

/** @param {Date} asOf */
export function rollingFandomYears(asOf) {
  const firstYear = addCalendarYears(asOf, -2).getUTCFullYear();
  const lastYear = asOf.getUTCFullYear();
  return Array.from(
    { length: lastYear - firstYear + 1 },
    (_, index) => firstYear + index,
  );
}

/** @param {Array<Record<string, any>>} values */
function uniqueBySourceKey(values) {
  return [...new Map(values.map((value) => [value.sourceKey, value])).values()];
}

/** @param {Array<Record<string, any>>} events */
function mergeEventsBySourceKey(events) {
  const merged = new Map();
  for (const event of events) {
    const existing = merged.get(event.sourceKey);
    if (!existing) {
      merged.set(event.sourceKey, event);
      continue;
    }
    const earlierProjected =
      new Date(existing.startsAt).getTime() <=
      new Date(event.startsAt).getTime()
        ? existing.startsAt
        : event.startsAt;
    const laterProjected =
      new Date(existing.endsAt).getTime() >= new Date(event.endsAt).getTime()
        ? existing.endsAt
        : event.endsAt;
    const earlierSource =
      new Date(existing.sourceStartsAt).getTime() <=
      new Date(event.sourceStartsAt).getTime()
        ? existing.sourceStartsAt
        : event.sourceStartsAt;
    const laterSource =
      new Date(existing.sourceEndsAt).getTime() >=
      new Date(event.sourceEndsAt).getTime()
        ? existing.sourceEndsAt
        : event.sourceEndsAt;
    merged.set(event.sourceKey, {
      ...existing,
      startsAt: earlierProjected,
      endsAt: laterProjected,
      sourceStartsAt: earlierSource,
      sourceEndsAt: laterSource,
    });
  }
  return [...merged.values()];
}

/** @param {Array<Record<string, any>>} entries */
export function uniqueEntries(entries) {
  const unique = /** @type {Array<Record<string, any>>} */ ([]);
  for (const entry of entries) {
    const pageIdentity = normaliseScheduleName(entry.pageTitle || entry.name);
    const entryStart = entry.startsAt
      ? new Date(entry.startsAt).getTime()
      : NaN;
    const entryEnd = entry.endsAt ? new Date(entry.endsAt).getTime() : NaN;
    const overlappingIndex = unique.findIndex((candidate) => {
      if (
        normaliseScheduleName(candidate.pageTitle || candidate.name) !==
          pageIdentity ||
        candidate.type !== entry.type
      ) {
        return false;
      }
      const candidateStart = candidate.startsAt
        ? new Date(candidate.startsAt).getTime()
        : NaN;
      const candidateEnd = candidate.endsAt
        ? new Date(candidate.endsAt).getTime()
        : NaN;
      return (
        Number.isFinite(entryStart) &&
        Number.isFinite(entryEnd) &&
        Number.isFinite(candidateStart) &&
        Number.isFinite(candidateEnd) &&
        entryStart <= candidateEnd &&
        candidateStart <= entryEnd
      );
    });
    if (overlappingIndex < 0) {
      unique.push(entry);
      continue;
    }
    const candidate = unique[overlappingIndex];
    if (!candidate) continue;
    unique[overlappingIndex] = {
      ...candidate,
      startsAt:
        new Date(candidate.startsAt).getTime() <= entryStart
          ? candidate.startsAt
          : entry.startsAt,
      endsAt:
        new Date(candidate.endsAt).getTime() >= entryEnd
          ? candidate.endsAt
          : entry.endsAt,
    };
  }
  return unique;
}

/** @param {string} value */
function titleTokens(value) {
  return new Set(
    normaliseScheduleName(value)
      .split(" ")
      .filter(
        (token) => token.length > 1 && !TITLE_ALIAS_IGNORED_TOKENS.has(token),
      ),
  );
}

/** @param {string} left @param {string} right */
function titleSimilarity(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  if (shared.length < TITLE_ALIAS_MINIMUM_SHARED_TOKENS) return 0;
  return shared.length / Math.min(leftTokens.size, rightTokens.size);
}

/**
 * Resolve a dead archive link only when one Global index entry is a strictly
 * better title match. Ambiguous aliases remain review issues.
 * @param {Record<string, any>} entry
 * @param {Array<Record<string, any>>} upcoming
 */
function findUpcomingAlias(entry, upcoming) {
  const ranked = upcoming
    .filter(
      ({ pageTitle, parseIssue, type }) =>
        pageTitle && !parseIssue && type === entry.type,
    )
    .map((candidate) => ({
      candidate,
      score: Math.max(
        titleSimilarity(entry.name, candidate.name),
        titleSimilarity(entry.pageTitle, candidate.pageTitle),
      ),
    }))
    .filter(({ score }) => score >= TITLE_ALIAS_MINIMUM_SIMILARITY)
    .sort((left, right) => right.score - left.score);
  return ranked[0] && (!ranked[1] || ranked[0].score > ranked[1].score)
    ? ranked[0].candidate
    : null;
}

/**
 * A yearly archive can place a campaign under an umbrella prefix even when
 * the detail page keeps the original title. Only an exact existing page is
 * accepted after removing one prefix.
 * @param {Record<string, any>} entry
 * @param {Map<string, FandomPage>} pagesByTitle
 * @returns {{name: string, pageTitle: string, page: FandomPage} | null}
 */
function findArchiveTitleAlias(entry, pagesByTitle) {
  for (const value of [entry.pageTitle, entry.name]) {
    const alias = value?.replace(ARCHIVE_UMBRELLA_PREFIX, "").trim();
    if (!alias || alias === value) continue;
    const page = pagesByTitle.get(normaliseScheduleName(alias));
    if (page) {
      return { name: page.title, pageTitle: page.title, page };
    }
  }
  return null;
}

/** @param {Record<string, any>} entry */
function archiveTitleCandidates(entry) {
  return [
    ...new Set(
      [entry.pageTitle, entry.name].flatMap((value) => {
        if (!value) return [];
        const alias = value.replace(ARCHIVE_UMBRELLA_PREFIX, "").trim();
        return alias && alias !== value ? [alias] : [];
      }),
    ),
  ];
}

/** @param {string} wikitext */
function transcludedPageTitles(wikitext) {
  return [
    ...new Set(
      [...wikitext.matchAll(/\{\{:\s*([^|}\n]+)(?:[|}])/g)]
        .map((match) => plainWikitext(match[1] ?? ""))
        .filter(Boolean),
    ),
  ];
}

/** @param {string} wikitext */
function mainArticleTitles(wikitext) {
  return [
    ...new Set(
      extractTemplates(wikitext, "Main")
        .map((template) =>
          plainWikitext(parseTemplateParameters(template).get("1") ?? ""),
        )
        .filter(Boolean),
    ),
  ];
}

/** @param {FandomPage} page */
function linkedQuestSubpages(page) {
  if (!page.title.startsWith("Main Quest:")) return [];
  const prefix = `${page.title}/`;
  return [
    ...new Set(
      [...page.wikitext.matchAll(/\[\[([^|#\]]+)/g)]
        .map((match) => plainWikitext(match[1] ?? ""))
        .filter((title) => title.startsWith(prefix)),
    ),
  ];
}

/**
 * Follow only explicit quest transclusions and a main-story page's own
 * subpages. The bounded two-step traversal prevents an event page from
 * expanding into the rest of the wiki.
 * @param {FandomPage} page
 * @param {string} entryType
 * @param {typeof fetchAllFandomRevisions} fetchRevisions
 */
async function fetchQuestFallbackPages(page, entryType, fetchRevisions) {
  const firstTitles = [
    ...transcludedPageTitles(page.wikitext),
    ...(entryType === "QUEST_RELEASE"
      ? mainArticleTitles(page.wikitext).map((title) => `Main Quest: ${title}`)
      : []),
  ];
  if (firstTitles.length === 0) return [];
  const firstPages = await fetchRevisions([...new Set(firstTitles)]);
  const secondTitles = firstPages.flatMap((candidate) => [
    ...transcludedPageTitles(candidate.wikitext),
    ...linkedQuestSubpages(candidate),
  ]);
  const existing = new Set(firstPages.map(({ title }) => title));
  const secondPages =
    secondTitles.filter((title) => !existing.has(title)).length > 0
      ? await fetchRevisions([
          ...new Set(secondTitles.filter((title) => !existing.has(title))),
        ])
      : [];
  return [...firstPages, ...secondPages];
}

/**
 * Keep an archive entry visible for review when its detail-page link is dead.
 * The archive page supplies the name and date only; no rewards are inferred.
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} listPage
 * @param {string} retrievedAt
 */
function normaliseListOnlyCandidate(entry, listPage, retrievedAt) {
  const identity = `${stableSlug(entry.name)}:${entry.startsAt.slice(0, 10)}`;
  const eventSourceKey = `fandom:JP:list-entry:${identity}:projection:NA`;
  const evidenceSourceKey = `fandom:JP:page:${listPage.pageId}`;
  return {
    source: {
      sourceKey: evidenceSourceKey,
      type: "WIKI",
      region: "JP",
      url: listPage.url,
      retrievedAt,
      contentHash: listPage.contentHash,
    },
    family: {
      sourceKey: `${eventSourceKey}:family`,
      name: entry.name,
      artworkUrl: null,
      artworkSourceUrl: null,
      artworkAlt: null,
      artworkReviewedAt: null,
    },
    event: {
      sourceKey: eventSourceKey,
      familySourceKey: `${eventSourceKey}:family`,
      evidenceSourceKey,
      name: entry.name,
      type: entry.type,
      startsAt: addCalendarYears(new Date(entry.startsAt), 2).toISOString(),
      startsAtPrecision: "DATE_ONLY",
      endsAt: addCalendarYears(new Date(entry.endsAt), 2).toISOString(),
      endsAtPrecision: "DATE_ONLY",
      status: "PROJECTED",
      sourceUrl: listPage.url,
      sourceRegion: "JP",
      sourceStartsAt: entry.startsAt,
      sourceEndsAt: entry.endsAt,
      projectionMethod: "TWO_CALENDAR_YEARS",
      lastSyncedAt: retrievedAt,
      sourceContentHash: listPage.contentHash,
    },
    rewardSources: [],
    issues: [
      {
        sourceKey: `${eventSourceKey}:missing-detail-page`,
        severity: "WARNING",
        message: `${entry.pageTitle} has no available detail page. The event-list name and dates require review, and no rewards were inferred.`,
      },
    ],
  };
}

/**
 * @param {Array<Record<string, any>>} upcoming
 * @param {Array<Record<string, any>>} sourceEntries
 * @param {Array<{entry: Record<string, any>, status: string}>} comparisons
 * @param {Array<{sourceEntry: Record<string, any>, upcomingEntry: Record<string, any>}>} resolvedAliases
 */
function assessUpcomingCoverage(
  upcoming,
  sourceEntries,
  comparisons,
  resolvedAliases,
) {
  const coveredNames = new Set();
  for (const comparison of comparisons) {
    if (comparison.status !== "EXCLUDED") {
      coveredNames.add(normaliseScheduleName(comparison.entry.name));
      coveredNames.add(normaliseScheduleName(comparison.entry.pageTitle));
    }
  }
  for (const entry of sourceEntries) {
    coveredNames.add(normaliseScheduleName(entry.name));
    coveredNames.add(normaliseScheduleName(entry.pageTitle));
  }
  for (const { sourceEntry, upcomingEntry } of resolvedAliases) {
    coveredNames.add(normaliseScheduleName(sourceEntry.name));
    coveredNames.add(normaliseScheduleName(sourceEntry.pageTitle));
    coveredNames.add(normaliseScheduleName(upcomingEntry.name));
    coveredNames.add(normaliseScheduleName(upcomingEntry.pageTitle));
  }

  return upcoming.map((entry) => ({
    name: entry.name,
    pageTitle: entry.pageTitle,
    eta: entry.eta,
    status:
      coveredNames.has(normaliseScheduleName(entry.name)) ||
      coveredNames.has(normaliseScheduleName(entry.pageTitle))
        ? "COVERED"
        : entry.exclusionReason || entry.parseIssue
          ? "EXCLUDED"
          : "MISSING_SOURCE_EVENT",
    note: entry.exclusionReason ?? entry.parseIssue ?? null,
  }));
}

/** @param {string} value */
function companionBase(value) {
  return normaliseScheduleName(value)
    .replace(/\bpre release\b/g, "")
    .replace(/\b(?:campaign|event|chapter|release)\b/g, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {Array<Record<string, any>>} upcoming
 * @param {Array<Record<string, any>>} sourceEntries
 * @param {Array<Record<string, any>>} candidatePages
 */
function findUpcomingCompanions(upcoming, sourceEntries, candidatePages) {
  const pagesByTitle = new Map(
    candidatePages.flatMap((page) =>
      [page.title, ...(page.aliases ?? [])].map((title) => [
        normaliseScheduleName(title),
        page,
      ]),
    ),
  );
  const preReleaseEntries = sourceEntries.filter(
    ({ type, parseIssue }) => type === "PRE_RELEASE_CAMPAIGN" && !parseIssue,
  );

  return upcoming.map((anchor) => {
    const anchorNames = [anchor.name, anchor.pageTitle]
      .map(companionBase)
      .filter((name) => name.length >= 4);
    const anchorEntry = sourceEntries.find(
      (entry) =>
        normaliseScheduleName(entry.pageTitle) ===
          normaliseScheduleName(anchor.pageTitle) ||
        normaliseScheduleName(entry.name) ===
          normaliseScheduleName(anchor.name),
    );
    const anchorStart = anchorEntry?.startsAt
      ? new Date(anchorEntry.startsAt).getTime()
      : null;
    const companions = preReleaseEntries.filter((entry) => {
      if (anchorStart !== null) {
        const companionStart = new Date(entry.startsAt).getTime();
        const companionEnd = new Date(entry.endsAt).getTime();
        if (companionStart > anchorStart || companionEnd < anchorStart) {
          return false;
        }
      }
      const entryBase = companionBase(entry.name);
      const direct = anchorNames.some(
        (anchorName) =>
          entryBase.includes(anchorName) || anchorName.includes(entryBase),
      );
      if (direct) return true;

      const page = pagesByTitle.get(normaliseScheduleName(entry.pageTitle));
      if (!page) return false;
      const linkedNames = [anchor.pageTitle, anchor.name]
        .filter((name) => name && name !== "#")
        .flatMap((name) => [
          name,
          name.replace(/\s+(?:Chapter|Permanent) Release$/i, ""),
        ])
        .filter((name, index, values) => name && values.indexOf(name) === index)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return linkedNames.some((name) =>
        new RegExp(`\\[\\[${name}(?:[|#\\]])`, "i").test(page.wikitext),
      );
    });
    return {
      name: anchor.name,
      pageTitle: anchor.pageTitle,
      companions: companions.map(({ name, pageTitle, startsAt, endsAt }) => ({
        name,
        pageTitle,
        startsAt,
        endsAt,
      })),
    };
  });
}

/**
 * Build a review dataset for supported Fandom entries that the Atlas event
 * export does not contain.
 * @param {Parameters<typeof selectRollingJpEvents>[0]} rawAtlasEvents
 * @param {{asOf: Date, rawWars?: Array<Record<string, any>>, warContentHash?: string | null, now?: () => Date, fetchRevisions?: typeof fetchAllFandomRevisions, fetchCategoryMembers?: typeof fetchFandomCategoryMembers}} options
 */
export async function buildFandomCoverage(rawAtlasEvents, options) {
  const fetchRevisions = options.fetchRevisions ?? fetchAllFandomRevisions;
  const fetchCategoryMembers =
    options.fetchCategoryMembers ?? fetchFandomCategoryMembers;
  const now = options.now ?? (() => new Date());
  const retrievedAt = now().toISOString();
  const years = rollingFandomYears(options.asOf);
  const listTitles = [...years.map(fandomYearTitle), FANDOM_UPCOMING_TITLE];
  const listPages = await fetchRevisions(listTitles);
  const listByTitle = new Map(listPages.map((page) => [page.title, page]));

  const missingListPages = listTitles.filter(
    (title) => !listByTitle.has(title),
  );
  if (missingListPages.length > 0) {
    throw new Error(
      `Fandom did not return required list pages: ${missingListPages.join(", ")}.`,
    );
  }
  const upcomingPage = listByTitle.get(FANDOM_UPCOMING_TITLE);
  const upcoming = parseFandomUpcomingEvents(upcomingPage?.wikitext ?? "");

  const categoryMembers = [
    ...(await fetchCategoryMembers("Current Event")),
    ...(await fetchCategoryMembers("Upcoming Event")),
  ];
  const categoryPages = await fetchRevisions(
    categoryMembers.map(({ title }) => title),
  );
  const categoryEntries = categoryPages.map((page) => {
    const header = parseFandomEventHeader(page.wikitext);
    const classification = classifyFandomScheduleEntry(page.title);
    return {
      listIndex: page.pageId,
      pageTitle: page.title,
      name: header?.name || page.title,
      imageName: null,
      startsAt: header?.startsAt,
      endsAt: header?.endsAt ?? header?.startsAt,
      type: classification.type,
      exclusionReason: classification.reason,
      parseIssue:
        header?.startsAt && (header.endsAt || header.startsAt)
          ? null
          : "The current or upcoming event page has no parseable EventHeaderJP dates.",
    };
  });

  const sourceFrom = addCalendarYears(options.asOf, -2).getTime();
  const sourceTo = options.asOf.getTime();
  const sourceEntries =
    /** @type {Array<{pageTitle: string, name: string, type: string | null, startsAt?: string, endsAt?: string, hasExplicitEnd?: boolean, exclusionReason?: string | null, parseIssue?: string | null}>} */ (
      uniqueEntries([
        ...years.flatMap((year) => {
          const page = listByTitle.get(fandomYearTitle(year));
          return parseFandomPastEventList(page?.wikitext ?? "", year);
        }),
        ...categoryEntries,
      ]).filter((entry) => {
        if (!entry.startsAt || !entry.endsAt) return true;
        if (entry.hasExplicitEnd === false) {
          return new Date(entry.startsAt).getTime() <= sourceTo;
        }
        return (
          new Date(entry.startsAt).getTime() <= sourceTo &&
          new Date(entry.endsAt).getTime() >= sourceFrom
        );
      })
    );
  const atlasWindow = selectRollingJpEvents(rawAtlasEvents, options.asOf);
  const rawWars = options.rawWars ?? [];
  const inferredWars = inferAtlasEventWarAssociations(
    atlasWindow,
    rawWars,
    classifyAtlasScheduleEvent,
  );
  const safelyAssociatedEventIds = new Set([
    ...atlasWindow
      .filter((event) =>
        (event.warIds ?? []).some((warId) =>
          rawWars.some(({ id }) => id === warId),
        ),
      )
      .map(({ id }) => id),
    ...rawWars.filter(({ eventId }) => eventId).map(({ eventId }) => eventId),
    ...inferredWars.associations.keys(),
  ]);
  const unresolvedAtlasEventIds = new Set(
    atlasWindow
      .filter((event) => {
        const type = classifyAtlasScheduleEvent(event);
        return (
          type &&
          ["MAIN_EVENT", "QUEST_RELEASE"].includes(type) &&
          !safelyAssociatedEventIds.has(event.id) &&
          !inferredWars.shadowedEventIds.has(event.id)
        );
      })
      .map(({ id }) => id),
  );
  const comparisons = compareFandomWithAtlas(sourceEntries, atlasWindow);
  const candidates =
    /** @type {Array<{pageTitle: string, name: string, type: string, startsAt: string, endsAt: string}>} */ (
      comparisons
        .filter(({ status }) => status === "REVIEW_CANDIDATE")
        .map(({ entry }) => entry)
    );
  const categoryPagesByTitle = indexPagesByTitle(categoryPages);
  const supportedComparisons = comparisons.filter(
    ({ status }) => status !== "EXCLUDED",
  );
  const newlyFetchedCandidatePages = await fetchRevisions(
    [
      ...supportedComparisons.flatMap(({ entry }) =>
        entry.pageTitle
          ? [entry.pageTitle, ...archiveTitleCandidates(entry)]
          : [],
      ),
      ...upcoming.flatMap(({ pageTitle }) =>
        pageTitle && pageTitle !== "#" ? [pageTitle] : [],
      ),
    ].filter(
      (title) => !categoryPagesByTitle.has(normaliseScheduleName(title)),
    ),
  );
  const candidatePages = [...categoryPages, ...newlyFetchedCandidatePages];
  const candidatePagesByNormalisedTitle = indexPagesByTitle(candidatePages);
  const normalized = [];
  const matchedSupplements = [];
  const supersededEvents = [];
  const unresolved = [];
  const resolvedAliases = [];
  const refinedAtlasMatches =
    /** @type {ReturnType<typeof compareFandomWithAtlas>} */ ([]);
  const limitedQuestFallbackArticles = new Set();
  const unmatchedQuestReleaseMetadata = [];
  const embeddedPermanentQuestReleases = [];

  for (const comparison of supportedComparisons) {
    const entry =
      /** @type {{pageTitle: string, name: string, type: string, startsAt: string, endsAt: string, hasExplicitEnd?: boolean}} */ (
        comparison.entry
      );
    const directPage = candidatePagesByNormalisedTitle.get(
      normaliseScheduleName(entry.pageTitle),
    );
    const redirectAlias =
      directPage &&
      normaliseScheduleName(directPage.title) !==
        normaliseScheduleName(entry.pageTitle)
        ? {
            name: directPage.title,
            pageTitle: directPage.title,
            page: directPage,
          }
        : null;
    const archiveAlias = directPage
      ? null
      : findArchiveTitleAlias(entry, candidatePagesByNormalisedTitle);
    const upcomingAlias =
      directPage || archiveAlias ? null : findUpcomingAlias(entry, upcoming);
    const page =
      directPage ??
      archiveAlias?.page ??
      (upcomingAlias
        ? candidatePagesByNormalisedTitle.get(
            normaliseScheduleName(upcomingAlias.pageTitle),
          )
        : null);
    if (!page) {
      const sourceYear = new Date(entry.startsAt).getUTCFullYear();
      const listPage = listByTitle.get(fandomYearTitle(sourceYear));
      unresolved.push({
        name: entry.name,
        pageTitle: entry.pageTitle,
        reason: listPage
          ? "Fandom did not return the detail page. A list-only review candidate was emitted."
          : "Fandom did not return the candidate page or its yearly archive.",
      });
      if (
        listPage &&
        (entry.hasExplicitEnd !== false ||
          new Date(entry.endsAt).getTime() >= sourceFrom)
      ) {
        normalized.push({
          ...normaliseListOnlyCandidate(entry, listPage, retrievedAt),
          coverageEntry: entry,
          coverageAlias: null,
        });
      }
      continue;
    }
    const resolvedAlias = redirectAlias ?? archiveAlias ?? upcomingAlias;
    if (resolvedAlias) {
      resolvedAliases.push({
        sourceEntry: entry,
        upcomingEntry: resolvedAlias,
      });
    }
    const result = normaliseFandomCampaign(
      page,
      redirectAlias ? { ...entry, name: page.title } : entry,
      { retrievedAt },
    );
    if (
      new Date(result.event.sourceEndsAt).getTime() < sourceFrom ||
      new Date(result.event.sourceStartsAt).getTime() > sourceTo
    ) {
      continue;
    }
    const refinedComparison =
      comparison.status === "REVIEW_CANDIDATE"
        ? compareFandomWithAtlas(
            [
              {
                ...entry,
                startsAt: result.event.sourceStartsAt,
                endsAt: result.event.sourceEndsAt,
              },
            ],
            atlasWindow,
          )[0]
        : null;
    const effectiveComparison =
      refinedComparison?.status === "MATCHED_ATLAS"
        ? refinedComparison
        : comparison;
    if (
      comparison.status === "REVIEW_CANDIDATE" &&
      effectiveComparison.status === "MATCHED_ATLAS"
    ) {
      refinedAtlasMatches.push(effectiveComparison);
    }
    if (
      effectiveComparison.status === "MATCHED_ATLAS" &&
      effectiveComparison.match
    ) {
      const atlasMatch = effectiveComparison.match;
      const atlasMatchId = Number(atlasMatch.id);
      if (!Number.isSafeInteger(atlasMatchId) || atlasMatchId <= 0) {
        throw new Error(
          `${atlasMatch.name} matched an Atlas record without a stable positive ID.`,
        );
      }
      const fallbackPages = unresolvedAtlasEventIds.has(atlasMatchId)
        ? await fetchQuestFallbackPages(page, entry.type, fetchRevisions)
        : [];
      const targetEventSourceKey = `atlas:JP:event:${atlasMatchId}:projection:NA`;
      const fallbackRewardSources = fallbackPages.flatMap((fallbackPage) =>
        extractFandomQuestParameterRewards(fallbackPage.wikitext, {
          pageId: fallbackPage.pageId,
          pageTitle: fallbackPage.title,
          eventSourceKey: null,
          externalEventSourceKey: targetEventSourceKey,
          evidenceSourceKey: `fandom:JP:page:${fallbackPage.pageId}`,
          evidenceUrl: fallbackPage.url,
          eventEndsAt: result.event.endsAt,
        }),
      );
      if (
        fallbackRewardSources.length > 0 &&
        new Date(result.event.sourceEndsAt).getTime() >
          new Date(result.event.sourceStartsAt).getTime()
      ) {
        for (const title of mainArticleTitles(page.wikitext)) {
          limitedQuestFallbackArticles.add(normaliseScheduleName(title));
        }
      }
      const fallbackSources = fallbackPages
        .filter((fallbackPage) =>
          fallbackRewardSources.some(
            ({ evidenceSourceKey }) =>
              evidenceSourceKey === `fandom:JP:page:${fallbackPage.pageId}`,
          ),
        )
        .map((fallbackPage) => ({
          sourceKey: `fandom:JP:page:${fallbackPage.pageId}`,
          type: "WIKI",
          region: "JP",
          url: fallbackPage.url,
          retrievedAt,
          contentHash: fallbackPage.contentHash,
        }));
      supersededEvents.push({
        sourceEventKey: result.event.sourceKey,
        targetEventKey: targetEventSourceKey,
        matchMethod: effectiveComparison.matchMethod,
        sourceName: result.event.name,
        targetName: atlasMatch.name,
      });
      const supportedSupplementTypes = new Set([
        "LOGIN_BONUS",
        "MASTER_MISSION",
        "MANA_PRISM_EXCHANGE",
        "MAINTENANCE",
      ]);
      const rewardSources = result.rewardSources
        .filter(({ type }) => supportedSupplementTypes.has(type))
        .map((source) => ({
          ...source,
          eventSourceKey: null,
          externalEventSourceKey: targetEventSourceKey,
        }));
      const heldRewardSources = result.rewardSources.filter(
        ({ type }) => !supportedSupplementTypes.has(type),
      );
      matchedSupplements.push({
        source: result.source,
        sources: [result.source, ...fallbackSources],
        rewardSources: [...rewardSources, ...fallbackRewardSources],
        heldRewardSources,
        issues: [
          ...result.issues,
          ...heldRewardSources.map((source) => ({
            sourceKey: `${source.sourceKey}:matched-atlas-review`,
            severity: "WARNING",
            message: `${source.name} was not added to the matched Atlas event because its reward type can overlap Atlas data. Review it for missing rewards.`,
          })),
        ],
      });
    } else {
      const warAssociation = associateFandomWarRewards(
        page,
        result,
        options.rawWars ?? [],
        {
          retrievedAt,
          warContentHash: options.warContentHash ?? null,
        },
      );
      const replacedKeys = new Set(warAssociation.replacedRewardSourceKeys);
      embeddedPermanentQuestReleases.push(
        ...warAssociation.embeddedReleases.map((release) => ({
          eventName: result.event.name,
          eventSourceKey: result.event.sourceKey,
          ...release,
        })),
      );
      const normalizedResult = {
        ...result,
        sources: [result.source, ...warAssociation.sources],
        rewardSources: [
          ...result.rewardSources.filter(
            ({ sourceKey }) => !replacedKeys.has(sourceKey),
          ),
          ...warAssociation.rewardSources,
        ],
        issues: [...result.issues, ...warAssociation.issues],
        coverageEntry: entry,
        coverageAlias: resolvedAlias,
      };
      normalized.push(normalizedResult);
      if (entry.type === "QUEST_RELEASE") {
        unmatchedQuestReleaseMetadata.push({
          result: normalizedResult,
          mainArticles: mainArticleTitles(page.wikitext).map(
            normaliseScheduleName,
          ),
          isPermanentRelease: /permanent release/i.test(result.event.name),
          rewardSourceQuestTypes: warAssociation.rewardSourceQuestTypes,
        });
      }
    }
  }

  for (const metadata of unmatchedQuestReleaseMetadata) {
    if (
      !metadata.isPermanentRelease ||
      !metadata.mainArticles.some((title) =>
        limitedQuestFallbackArticles.has(title),
      )
    ) {
      continue;
    }
    metadata.result.rewardSources = metadata.result.rewardSources.map(
      (source) => {
        const questType = metadata.rewardSourceQuestTypes.get(source.sourceKey);
        if (!questType || questType === "free") return source;
        return {
          ...source,
          rewards: source.rewards.map((reward) => {
            const eligibility =
              "eligibility" in reward && typeof reward.eligibility === "string"
                ? reward.eligibility
                : `Clear ${source.name}.`;
            return {
              ...reward,
              defaultIncluded: false,
              eligibility: `${eligibility} This reward may already have been claimed during the earlier limited release.`,
            };
          }),
        };
      },
    );
  }

  const invalidRange = normalized.find(
    ({ event }) =>
      event.endsAt && new Date(event.endsAt) < new Date(event.startsAt),
  );
  if (invalidRange) {
    throw new Error(
      `Fandom normalisation produced an invalid range for ${invalidRange.coverageEntry.name}` +
        `${invalidRange.coverageAlias ? ` via ${invalidRange.coverageAlias.pageTitle}` : ""}: ` +
        `${invalidRange.event.startsAt} to ${invalidRange.event.endsAt}.`,
    );
  }

  const dataset = parseEventDataset({
    schemaVersion: 1,
    generatedAt: retrievedAt,
    review: {
      status: "NEEDS_REVIEW",
      reviewedAt: null,
      note: "Fandom coverage candidates require review before import.",
    },
    sources: uniqueBySourceKey([
      ...listPages.map((page) => ({
        sourceKey: `fandom:JP:page:${page.pageId}`,
        type: "WIKI",
        region: page.title === FANDOM_UPCOMING_TITLE ? "NA" : "JP",
        url: page.url,
        retrievedAt,
        contentHash: page.contentHash,
      })),
      ...normalized.flatMap((value) =>
        "sources" in value ? value.sources : [value.source],
      ),
      ...matchedSupplements.flatMap(
        ({ sources, source }) => sources ?? [source],
      ),
    ]),
    families: uniqueBySourceKey(normalized.map(({ family }) => family)),
    events: mergeEventsBySourceKey(normalized.map(({ event }) => event)),
    rewardSources: uniqueBySourceKey([
      ...normalized.flatMap(({ rewardSources }) => rewardSources),
      ...matchedSupplements.flatMap(({ rewardSources }) => rewardSources),
    ]),
    issues: uniqueBySourceKey([
      ...normalized.flatMap(({ issues }) => issues),
      ...matchedSupplements.flatMap(({ issues }) => issues),
      ...comparisons
        .filter(({ status }) => status === "EXCLUDED")
        .map(({ entry }, index) => ({
          sourceKey: `fandom:coverage:excluded:${index}`,
          severity: "INFO",
          message: `${entry.name || entry.pageTitle}: ${entry.exclusionReason ?? entry.parseIssue}`,
        })),
      ...unresolved.map((entry, index) => ({
        sourceKey: `fandom:coverage:unresolved:${index}`,
        severity: "WARNING",
        message: `${entry.pageTitle}: ${entry.reason}`,
      })),
    ]),
  });

  return {
    dataset,
    supersededEvents,
    report: {
      atlasFetched: rawAtlasEvents.length,
      atlasSelected: atlasWindow.length,
      fandomListEntries: sourceEntries.length,
      matchedAtlas:
        comparisons.filter(({ status }) => status === "MATCHED_ATLAS").length +
        refinedAtlasMatches.length,
      supersededEventMatches: supersededEvents.length,
      matchMethods: Object.fromEntries(
        ["EXACT_NAME", "NAME_SIMILARITY", "DATE_AND_NAME", "DATE_RANGE"].map(
          (method) => [
            method,
            comparisons.filter(
              (comparison) => comparison.matchMethod === method,
            ).length +
              refinedAtlasMatches.filter(
                (comparison) => comparison.matchMethod === method,
              ).length,
          ],
        ),
      ),
      reviewCandidates: candidates.length - refinedAtlasMatches.length,
      embeddedPermanentQuestReleases,
      matchedSupplementRewards: matchedSupplements.reduce(
        (count, result) => count + result.rewardSources.length,
        0,
      ),
      heldMatchedRewardSources: matchedSupplements.flatMap(
        ({ heldRewardSources, source }) =>
          heldRewardSources.map((rewardSource) => ({
            pageUrl: source.url,
            name: rewardSource.name,
            type: rewardSource.type,
            rewards: rewardSource.rewards.map(({ itemType, amount }) => ({
              itemType,
              amount,
            })),
          })),
      ),
      explicitExclusions: comparisons
        .filter(({ status }) => status === "EXCLUDED")
        .map(({ entry }) => ({
          name: entry.name,
          reason: entry.exclusionReason ?? entry.parseIssue,
        })),
      unresolved,
      upcoming: assessUpcomingCoverage(
        upcoming,
        sourceEntries,
        comparisons,
        resolvedAliases,
      ),
      resolvedAliases: resolvedAliases.map(
        ({ sourceEntry, upcomingEntry }) => ({
          sourceName: sourceEntry.name,
          sourcePageTitle: sourceEntry.pageTitle,
          resolvedName: upcomingEntry.name,
          resolvedPageTitle: upcomingEntry.pageTitle,
        }),
      ),
      upcomingCompanions: findUpcomingCompanions(
        upcoming,
        sourceEntries,
        candidatePages,
      ),
      revisions: [...listPages, ...candidatePages].map(
        ({
          pageId,
          title,
          revisionId,
          revisionTimestamp,
          contentHash,
          url,
        }) => ({
          pageId,
          title,
          revisionId,
          revisionTimestamp,
          contentHash,
          url,
        }),
      ),
    },
  };
}
