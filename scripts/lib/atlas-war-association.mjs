import { normalizeAtlasWarRewards } from "./atlas-event-adapter.mjs";
import {
  ATLAS_PERMANENT_QUEST_WAR_IDS,
  findAtlasPermanentQuestWar,
} from "./atlas-domain.mjs";
import { parseJstDate } from "./fandom-campaign-adapter.mjs";
import { addCalendarYears } from "./jp-event-sync.mjs";

const DAY_SECONDS = 86_400;
const DEFAULT_PERMANENT_RELEASE_DAYS = 7;
const MAX_PERMANENT_RELEASE_DAYS = 14;
const STORY_WAR_RELEASE_DAYS = 90;
const STORY_WAR_MINIMUM_OPENING_QUESTS = 3;
const JST_OFFSET_SECONDS = 9 * 60 * 60;

/** @typedef {"RANK_UP" | "INTERLUDE"} PermanentQuestKind */

/** @type {Readonly<Record<PermanentQuestKind, RegExp>>} */
const PERMANENT_QUEST_SECTION_PATTERNS = Object.freeze({
  RANK_UP: /^(?:servant\s+)?(?:strengthening|rank up) quests?$/i,
  INTERLUDE: /^(?:new\s+)?interludes?(?:\s+(?:released|release))?$/i,
});

/** @param {Record<string, any>} war */
function questsInWar(war) {
  return (war.spots ?? []).flatMap(
    (/** @type {Record<string, any>} */ spot) => spot.quests ?? [],
  );
}

/** @param {string | null | undefined} value */
function sourceSeconds(value) {
  return value ? Math.floor(new Date(value).getTime() / 1_000) : null;
}

/** @param {string} wikitext */
function permanentReleaseDays(wikitext) {
  const declared = wikitext.match(/total of\s+(\d+)\s+days?/i);
  const declaredDays = Number(declared?.[1]);
  if (
    Number.isSafeInteger(declaredDays) &&
    declaredDays > 0 &&
    declaredDays <= MAX_PERMANENT_RELEASE_DAYS
  ) {
    return declaredDays;
  }

  const dates = [
    ...wikitext.matchAll(
      /(?:^|\n)\|\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2})\s*~/g,
    ),
  ]
    .map((match) => parseJstDate(match[1] ?? ""))
    .filter((value) => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (firstDate && lastDate) {
    const days =
      Math.floor(
        (lastDate.getTime() - firstDate.getTime()) / (DAY_SECONDS * 1_000),
      ) + 1;
    if (days > 0 && days <= MAX_PERMANENT_RELEASE_DAYS) return days;
  }
  return DEFAULT_PERMANENT_RELEASE_DAYS;
}

/**
 * @param {Array<Record<string, any>>} wars
 * @param {number} startsAt
 */
function findStoryWar(wars, startsAt) {
  const candidates = wars
    .filter((war) => !war.eventId && !ATLAS_PERMANENT_QUEST_WAR_IDS.has(war.id))
    .map((war) => ({
      war,
      openingQuests: questsInWar(war).filter(
        (/** @type {Record<string, any>} */ quest) =>
          quest.openedAt === startsAt,
      ).length,
    }))
    .filter(
      ({ openingQuests }) => openingQuests >= STORY_WAR_MINIMUM_OPENING_QUESTS,
    )
    .sort((left, right) => right.openingQuests - left.openingQuests);
  if (!candidates[0]) return { war: null, ambiguous: false };
  if (
    candidates[1] &&
    candidates[1].openingQuests === candidates[0].openingQuests
  ) {
    return { war: null, ambiguous: true };
  }
  return { war: candidates[0].war, ambiguous: false };
}

/**
 * @param {Record<string, any>} war
 * @param {number} startsAt
 * @param {number} durationDays
 * @returns {Record<string, any>}
 */
function filterWarByReleaseWindow(war, startsAt, durationDays) {
  const endsBefore = startsAt + durationDays * DAY_SECONDS;
  return {
    ...war,
    spots: (war.spots ?? []).map((/** @type {Record<string, any>} */ spot) => ({
      ...spot,
      quests: (spot.quests ?? []).filter(
        (/** @type {Record<string, any>} */ quest) =>
          quest.openedAt >= startsAt && quest.openedAt < endsBefore,
      ),
    })),
  };
}

/**
 * @param {Record<string, any>} war
 * @param {Array<{startsAt: number, endsBefore: number}>} windows
 * @returns {Record<string, any>}
 */
function filterWarByReleaseWindows(war, windows) {
  return {
    ...war,
    spots: (war.spots ?? []).map((/** @type {Record<string, any>} */ spot) => ({
      ...spot,
      quests: (spot.quests ?? []).filter(
        (/** @type {Record<string, any>} */ quest) =>
          windows.some(
            ({ startsAt, endsBefore }) =>
              quest.openedAt >= startsAt && quest.openedAt < endsBefore,
          ),
      ),
    })),
  };
}

/** @param {string} value */
function releaseMarkerParts(value) {
  const match = value.match(
    /([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?/i,
  );
  if (!match) return null;
  return {
    month: match[1] ?? "",
    day: match[2] ?? "",
    year: match[3] ? Number(match[3]) : null,
    hour: match[4] ? Number(match[4]) : null,
    minute: match[5] ? Number(match[5]) : null,
  };
}

/**
 * Convert an embedded Fandom "Added on" marker into a bounded UTC window.
 * Date-only markers cover one JST calendar day; timed markers cover one minute.
 * @param {string} value
 * @param {number} eventStartsAt
 * @param {number | null} eventEndsAt
 */
function releaseMarkerWindow(value, eventStartsAt, eventEndsAt) {
  const parts = releaseMarkerParts(value);
  if (!parts) return null;
  const eventStartJst = new Date((eventStartsAt + JST_OFFSET_SECONDS) * 1_000);
  const eventEndJst = new Date(
    ((eventEndsAt ?? eventStartsAt + 366 * DAY_SECONDS) + JST_OFFSET_SECONDS) *
      1_000,
  );
  const years = parts.year
    ? [parts.year]
    : [
        ...new Set([
          eventStartJst.getUTCFullYear(),
          eventEndJst.getUTCFullYear(),
        ]),
      ];

  for (const year of years) {
    const time = `${parts.month} ${parts.day}, ${year}${
      parts.hour === null
        ? ""
        : ` ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
    }`;
    const date = parseJstDate(time);
    if (!date) continue;
    const startsAt = Math.floor(date.getTime() / 1_000);
    const endsBefore = startsAt + (parts.hour === null ? DAY_SECONDS : 60);
    if (
      startsAt >= eventStartsAt - DAY_SECONDS &&
      startsAt <=
        (eventEndsAt ?? eventStartsAt + 366 * DAY_SECONDS) + DAY_SECONDS
    ) {
      return { startsAt, endsBefore };
    }
  }
  return null;
}

/**
 * Find permanent quest releases nested inside an otherwise unrelated campaign.
 * The section name and its own release markers are used; the campaign name is
 * deliberately not part of this contract.
 * @param {string} wikitext
 * @param {number} eventStartsAt
 * @param {number | null} eventEndsAt
 */
export function embeddedPermanentQuestReleases(
  wikitext,
  eventStartsAt,
  eventEndsAt,
) {
  const headings = [...wikitext.matchAll(/^(={2,5})\s*(.+?)\s*\1\s*$/gm)];
  const releases = [];
  for (const [index, heading] of headings.entries()) {
    const level = heading[1]?.length ?? 2;
    const name = (heading[2] ?? "")
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
      .replace(/'{2,}/g, "")
      .trim();
    const kind = /** @type {PermanentQuestKind | undefined} */ (
      /** @type {PermanentQuestKind[]} */ (["RANK_UP", "INTERLUDE"]).find(
        (candidate) => PERMANENT_QUEST_SECTION_PATTERNS[candidate].test(name),
      )
    );
    if (!kind) continue;
    const nextHeading = headings
      .slice(index + 1)
      .find((candidate) => (candidate[1]?.length ?? 2) <= level);
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = nextHeading?.index ?? wikitext.length;
    const section = wikitext.slice(sectionStart, sectionEnd);
    const windows = [
      ...section.matchAll(
        /\bAdded\s+on\s+([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?(?:\s+\d{1,2}:\d{2})?)(?:\s*\(?JST\)?)?/gi,
      ),
    ]
      .map((match) =>
        releaseMarkerWindow(match[1] ?? "", eventStartsAt, eventEndsAt),
      )
      .filter((window) => window !== null);
    const uniqueWindows = [
      ...new Map(
        windows.map((window) => [
          `${window.startsAt}:${window.endsBefore}`,
          window,
        ]),
      ).values(),
    ];
    releases.push({ kind, sectionName: name, windows: uniqueWindows });
  }
  return releases;
}

/** @param {Array<Record<string, any>>} sources */
function rewardTotals(sources) {
  const totals = new Map();
  for (const reward of sources.flatMap(({ rewards }) => rewards)) {
    totals.set(
      reward.itemType,
      (totals.get(reward.itemType) ?? 0) + reward.amount,
    );
  }
  return totals;
}

/**
 * Link an unmatched Fandom schedule entry to Atlas war rewards without
 * treating a date-only coincidence as sufficient evidence.
 * @param {{pageId: number, wikitext: string}} page
 * @param {{event: Record<string, any>, rewardSources: Array<Record<string, any>>}} result
 * @param {Array<Record<string, any>>} rawWars
 * @param {{retrievedAt: string, warContentHash: string | null}} options
 */
export function associateFandomWarRewards(page, result, rawWars, options) {
  const startsAt = sourceSeconds(result.event.sourceStartsAt);
  if (!startsAt) {
    return {
      sources: [],
      rewardSources: [],
      issues: [],
      replacedRewardSourceKeys: [],
      rewardSourceQuestTypes: new Map(),
      embeddedReleases: [],
    };
  }

  const name = result.event.name;
  const isRankUp = /strengthening quests?|rank up quests?/i.test(name);
  const isInterlude = /interlude campaign/i.test(name);
  const eventEndsAt = sourceSeconds(result.event.sourceEndsAt);
  /** @type {Array<{war: Record<string, any>, defaultIncluded: boolean, embeddedRelease?: {kind: PermanentQuestKind, sectionName: string, questCount: number}}>} */
  const associations = [];
  let ambiguous = false;
  const associationIssues = [];

  if (isRankUp || isInterlude) {
    const match = findAtlasPermanentQuestWar(
      rawWars,
      isRankUp ? "RANK_UP" : "INTERLUDE",
    );
    const sharedWar = match.war;
    const contractIssue = match.issue;
    if (sharedWar) {
      associations.push({
        war: filterWarByReleaseWindow(
          sharedWar,
          startsAt,
          permanentReleaseDays(page.wikitext),
        ),
        defaultIncluded: false,
      });
    } else {
      associationIssues.push(
        contractIssue ??
          `${name} has no safely matched Atlas permanent quest war. Quest rewards require review.`,
      );
    }
  } else if (result.event.type === "QUEST_RELEASE") {
    const match = findStoryWar(rawWars, startsAt);
    ambiguous = match.ambiguous;
    if (match.war) {
      associations.push({
        war: filterWarByReleaseWindow(
          match.war,
          startsAt,
          STORY_WAR_RELEASE_DAYS,
        ),
        defaultIncluded: true,
      });
    } else {
      associationIssues.push(
        ambiguous
          ? `${name} matched more than one Atlas war at its release time. Quest rewards require review.`
          : `${name} has no safely matched Atlas war. Quest rewards require review.`,
      );
    }
  }

  if (!isRankUp && !isInterlude) {
    for (const release of embeddedPermanentQuestReleases(
      page.wikitext,
      startsAt,
      eventEndsAt,
    )) {
      if (release.windows.length === 0) {
        // Some campaign pages use these sections only for AP discounts or
        // unlock notices. Without an explicit release marker, there is no
        // evidence that a new permanent quest reward belongs to this event.
        continue;
      }
      const match = findAtlasPermanentQuestWar(rawWars, release.kind);
      if (!match.war) {
        associationIssues.push(
          match.issue ??
            `${release.sectionName} has no safely matched Atlas permanent quest war. Quest rewards require review.`,
        );
        continue;
      }
      const filteredWar = filterWarByReleaseWindows(match.war, release.windows);
      if (questsInWar(filteredWar).length === 0) {
        associationIssues.push(
          `${release.sectionName} has no Atlas quest opening at its published release time. Quest rewards require review.`,
        );
        continue;
      }
      associations.push({
        war: filteredWar,
        defaultIncluded: false,
        embeddedRelease: {
          kind: release.kind,
          sectionName: release.sectionName,
          questCount: questsInWar(filteredWar).length,
        },
      });
    }
  }

  const normalizedAssociations = associations.map(({ war, defaultIncluded }) =>
    normalizeAtlasWarRewards(war, {
      region: "JP",
      retrievedAt: options.retrievedAt,
      contentHash: options.warContentHash,
      eventId: page.pageId,
      eventSourceKey: result.event.sourceKey,
      sourceKeyPrefix: `atlas:JP:war:${war.id}`,
      defaultIncluded,
    }),
  );
  const rewardSources = normalizedAssociations.flatMap((normalized) =>
    normalized.rewardSources.map((source) => ({
      ...source,
      sourceKey: `${source.sourceKey}:projection:NA`,
      status: "PROJECTED",
      rewards: source.rewards.map(
        (/** @type {Record<string, any>} */ reward) => ({
          ...reward,
          sourceKey: `${reward.sourceKey}:projection:NA`,
          expectedAt: reward.expectedAt
            ? addCalendarYears(new Date(reward.expectedAt), 2).toISOString()
            : result.event.endsAt,
          reviewedAt: null,
        }),
      ),
    })),
  );
  const rewardSourceQuestTypes = new Map();
  for (const { war } of associations) {
    for (const quest of questsInWar(war)) {
      const questSourcePrefix = `atlas:JP:war:${war.id}:quest:${quest.id}`;
      for (const source of rewardSources) {
        if (
          source.sourceKey === questSourcePrefix ||
          source.sourceKey.startsWith(`${questSourcePrefix}:`)
        ) {
          rewardSourceQuestTypes.set(source.sourceKey, quest.type ?? null);
        }
      }
    }
  }
  const atlasTotals = rewardTotals(rewardSources);
  const replacementCandidates = associations.some(
    ({ defaultIncluded }) => defaultIncluded === false,
  )
    ? result.rewardSources.filter((source) =>
        ["OTHER", "QUEST_CLEAR"].includes(source.type),
      )
    : [];
  const candidateTotals = rewardTotals(replacementCandidates);
  const canReplaceCandidates =
    replacementCandidates.length > 0 &&
    [...candidateTotals].every(
      ([itemType, amount]) => (atlasTotals.get(itemType) ?? 0) >= amount,
    );
  const replacedRewardSourceKeys = canReplaceCandidates
    ? replacementCandidates.map(({ sourceKey }) => sourceKey)
    : [];

  return {
    sources: normalizedAssociations.map(({ source }) => source),
    rewardSources,
    issues: [
      ...normalizedAssociations.flatMap(({ issues }) => issues),
      ...associationIssues.map((message, index) => ({
        sourceKey: `${result.event.sourceKey}:war-review:${index + 1}`,
        severity: "WARNING",
        message,
      })),
    ],
    replacedRewardSourceKeys,
    rewardSourceQuestTypes,
    embeddedReleases: associations.flatMap(({ war, embeddedRelease }) =>
      embeddedRelease ? [{ ...embeddedRelease, warId: war.id }] : [],
    ),
  };
}
