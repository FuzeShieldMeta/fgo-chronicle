import {
  extractTemplates,
  normaliseScheduleName,
  parseTemplateParameters,
  plainWikitext,
} from "./wikitext.mjs";
import { classifyAtlasScheduleEvent } from "./jp-event-sync.mjs";

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index]),
);

/** @param {string} value */
function splitLinkedTitle(value) {
  const expanded = value.replace(/\{\{!\}\}/g, "|").trim();
  const parts = expanded.split("|").map((part) => plainWikitext(part));
  return {
    pageTitle: parts[0] ?? "",
    displayName: parts.at(-1) ?? "",
  };
}

/** @param {string} value @param {number} year */
function parseMonthDay(value, year) {
  const match = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (!match) return null;
  const month = MONTHS.get((match[1] ?? "").toLowerCase());
  const day = Number(match[2]);
  const resolvedYear = match[3] ? Number(match[3]) : year;
  if (month === undefined || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(resolvedYear, month, day));
  if (
    date.getUTCFullYear() !== resolvedYear ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * @param {string} startValue
 * @param {string} endValue
 * @param {number} year
 */
export function parsePastEventDates(startValue, endValue, year) {
  const inlineRange = startValue.split(/\s*~\s*/);
  const rawStart = inlineRange[0]?.trim() ?? "";
  const rawEnd = (endValue || inlineRange[1] || rawStart).trim();
  const start = parseMonthDay(rawStart, year);
  if (!start) return null;

  let end = parseMonthDay(rawEnd, year);
  if (!end) return null;
  if (end < start && !/,\s*\d{4}$/.test(rawEnd)) {
    end = parseMonthDay(rawEnd, year + 1);
  }
  if (!end || end < start) return null;

  return {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

/** @param {string} name */
export function classifyFandomScheduleEntry(name) {
  if (/summon(?:ing)? campaign|weekly summoning|pickup summon/i.test(name)) {
    return { type: null, reason: "Standalone summoning campaign" };
  }
  if (/start dash|new master aid/i.test(name)) {
    return { type: null, reason: "New-player-only campaign" };
  }
  if (/questionnaire/i.test(name)) {
    return { type: "CAMPAIGN", reason: null };
  }
  if (/pre[- ]?release|countdown campaign/i.test(name)) {
    return { type: "PRE_RELEASE_CAMPAIGN", reason: null };
  }
  if (/chapter (?:release|preface)|permanent release/i.test(name)) {
    return { type: "QUEST_RELEASE", reason: null };
  }
  if (/login bonus/i.test(name)) {
    return { type: "LOGIN_BONUS", reason: null };
  }
  if (/campaign|anniversary|commemoration|collection/i.test(name)) {
    return { type: "CAMPAIGN", reason: null };
  }
  return { type: "MAIN_EVENT", reason: null };
}

/** @param {string} wikitext @param {number} year */
export function parseFandomPastEventList(wikitext, year) {
  const source = wikitext.replace(/<!--[^]*?-->/g, "");
  return extractTemplates(source, "PastEvent").map((template, index) => {
    const parameters = parseTemplateParameters(template);
    const eventValue = parameters.get("event") ?? "";
    const { pageTitle, displayName } = splitLinkedTitle(eventValue);
    const dates = parsePastEventDates(
      parameters.get("start") ?? "",
      parameters.get("end") ?? "",
      year,
    );
    const hasExplicitEnd = Boolean(
      parameters.get("end")?.trim() ||
      (parameters.get("start") ?? "").includes("~"),
    );
    const classification = classifyFandomScheduleEntry(displayName);
    return {
      listIndex: index,
      pageTitle,
      name: displayName,
      imageName: parameters.get("image")?.trim() || null,
      ...dates,
      hasExplicitEnd,
      type: classification.type,
      exclusionReason: classification.reason,
      parseIssue:
        !pageTitle || pageTitle === "#"
          ? "The event list entry does not link to a wiki page."
          : !dates
            ? "The event list entry has an invalid date range."
            : null,
    };
  });
}

/** @param {string} wikitext */
export function parseFandomUpcomingEvents(wikitext) {
  const source = wikitext.replace(/<!--[^]*?-->/g, "");
  return extractTemplates(source, "EtaEventNA").map((template, index) => {
    const parameters = parseTemplateParameters(template);
    const { pageTitle, displayName } = splitLinkedTitle(
      parameters.get("event") ?? "",
    );
    const eta = plainWikitext(parameters.get("eta") ?? "");
    const classification = classifyFandomScheduleEntry(displayName);
    return {
      listIndex: index,
      pageTitle,
      name: displayName,
      eta,
      imageName: parameters.get("image")?.trim() || null,
      type: classification.type,
      exclusionReason: classification.reason,
      parseIssue:
        !pageTitle || pageTitle === "#"
          ? "The upcoming entry does not link to a source event."
          : !/^[A-Za-z]+\s+\d{4}$/.test(eta)
            ? "The upcoming entry has an invalid month estimate."
            : null,
    };
  });
}

/**
 * @param {{name: string, pageTitle?: string, type?: string | null, startsAt?: string, endsAt?: string, exclusionReason?: string | null, parseIssue?: string | null}[]} fandomEntries
 * @param {{id?: number, type: string, name: string, originalName?: string | null, startedAt: number, endedAt: number}[]} atlasEvents
 */
export function compareFandomWithAtlas(fandomEntries, atlasEvents) {
  const results = [];

  /** @param {string} name */
  const tokens = (name) =>
    new Set(
      normaliseScheduleName(name)
        .split(" ")
        .filter(
          (token) =>
            token.length > 2 &&
            !new Set(["the", "and", "event", "campaign", "release"]).has(token),
        ),
    );
  /** @param {string} left @param {string} right */
  const similarity = (left, right) => {
    const leftTokens = tokens(left);
    const rightTokens = tokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    const shared = [...leftTokens].filter((token) => rightTokens.has(token));
    return shared.length / Math.min(leftTokens.size, rightTokens.size);
  };
  /** @param {number} seconds */
  const jpDate = (seconds) =>
    new Date(seconds * 1_000 + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  /** @param {string | null | undefined} fandomType @param {{type: string, name: string, originalName?: string | null, startedAt: number, endedAt: number}} event */
  const hasCompatibleType = (fandomType, event) => {
    const atlasType = classifyAtlasScheduleEvent(event);
    if (fandomType === "MAIN_EVENT") return atlasType === "MAIN_EVENT";
    if (fandomType === "QUEST_RELEASE") return atlasType === "QUEST_RELEASE";
    return atlasType === fandomType;
  };
  /** @param {string | null | undefined} fandomType @param {{type: string, name: string, originalName?: string | null, startedAt: number, endedAt: number}} event */
  const isFiniteChapterStoredAsMainEvent = (fandomType, event) =>
    fandomType === "QUEST_RELEASE" &&
    classifyAtlasScheduleEvent(event) === "MAIN_EVENT";

  for (const entry of fandomEntries) {
    if (entry.exclusionReason || entry.parseIssue) {
      results.push({
        entry,
        status: "EXCLUDED",
        match: null,
        matchMethod: null,
      });
      continue;
    }
    const exactNames = new Set(
      [entry.name, entry.pageTitle].flatMap((name) =>
        typeof name === "string" ? [normaliseScheduleName(name)] : [],
      ),
    );
    const exactCandidates = atlasEvents.filter((event) =>
      [event.name, event.originalName].some(
        (name) =>
          typeof name === "string" &&
          exactNames.has(normaliseScheduleName(name)),
      ),
    );
    const exactMatch = exactCandidates.length === 1 ? exactCandidates[0] : null;
    let match = exactMatch;
    let matchMethod = exactMatch ? "EXACT_NAME" : null;

    if (!match) {
      const ranked = atlasEvents
        .filter((event) => hasCompatibleType(entry.type, event))
        .map((event) => ({
          event,
          score: Math.max(
            similarity(entry.name, event.name),
            similarity(entry.pageTitle ?? "", event.name),
          ),
        }))
        .filter(({ score }) => score >= 0.6)
        .sort((left, right) => right.score - left.score);
      if (ranked[0] && (!ranked[1] || ranked[0].score > ranked[1].score)) {
        match = ranked[0].event;
        matchMethod = "NAME_SIMILARITY";
      }
    }

    if (!match && typeof entry.startsAt === "string") {
      const entryDate = entry.startsAt.slice(0, 10);
      const sameDay = atlasEvents
        .filter(
          (event) =>
            (hasCompatibleType(entry.type, event) ||
              isFiniteChapterStoredAsMainEvent(entry.type, event)) &&
            jpDate(event.startedAt) === entryDate,
        )
        .map((event) => ({
          event,
          score: Math.max(
            similarity(entry.name, event.name),
            similarity(entry.pageTitle ?? "", event.name),
          ),
          sameDateRange:
            typeof entry.endsAt === "string" &&
            jpDate(event.endedAt) === entry.endsAt.slice(0, 10),
        }))
        .filter(({ event, score, sameDateRange }) =>
          isFiniteChapterStoredAsMainEvent(entry.type, event)
            ? sameDateRange
            : score > 0 || sameDateRange,
        )
        .sort(
          (left, right) =>
            right.score - left.score ||
            Number(right.sameDateRange) - Number(left.sameDateRange),
        );
      if (
        sameDay[0] &&
        (!sameDay[1] ||
          sameDay[0].score > sameDay[1].score ||
          (sameDay[0].score === sameDay[1].score &&
            sameDay[0].sameDateRange &&
            !sameDay[1].sameDateRange))
      ) {
        match = sameDay[0].event;
        matchMethod = sameDay[0].score > 0 ? "DATE_AND_NAME" : "DATE_RANGE";
      }
    }
    results.push({
      entry,
      status: match ? "MATCHED_ATLAS" : "REVIEW_CANDIDATE",
      match,
      matchMethod,
    });
  }
  return results;
}
