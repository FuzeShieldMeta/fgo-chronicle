import { createHash } from "node:crypto";

import { addCalendarYears } from "./jp-event-sync.mjs";
import {
  extractNestedTemplates,
  extractTemplates,
  parseTemplateParameters,
  plainWikitext,
  stableSlug,
} from "./wikitext.mjs";

const TRACKED_TEMPLATES = new Map([
  ["saint quartz", "SAINT_QUARTZ"],
  ["saint quartz fragment", "SAINT_QUARTZ_FRAGMENT"],
  ["saint quartz fragments", "SAINT_QUARTZ_FRAGMENT"],
  ["summon ticket", "SUMMON_TICKET"],
  ["crystallized lore", "CRYSTALLIZED_LORE"],
  ["crystallised lore", "CRYSTALLIZED_LORE"],
  ["holy grail", "HOLY_GRAIL"],
]);
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MINUTE_MILLISECONDS = 60 * 1_000;
const JST_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1_000;

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
for (const [month, index] of [...MONTHS]) {
  MONTHS.set(month.slice(0, 3), index);
}

/** @param {string} value */
export function parseJstDate(value) {
  const match = value
    .trim()
    .replace(/\s+JST$/i, "")
    .match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  const month = MONTHS.get((match[1] ?? "").toLowerCase());
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const date = new Date(Date.UTC(year, month, day, hour - 9, minute));
  const jstCheck = new Date(date.getTime() + 9 * 60 * 60 * 1_000);
  if (
    jstCheck.getUTCFullYear() !== year ||
    jstCheck.getUTCMonth() !== month ||
    jstCheck.getUTCDate() !== day ||
    jstCheck.getUTCHours() !== hour ||
    jstCheck.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

/** @param {string} value */
export function parseJstDateRange(value) {
  const parts = value
    .replace(/\s+JST\b/gi, "")
    .split(/\s*[~–—]\s*/)
    .map((part) => part.trim());
  if (parts.length < 2) return null;
  const start = parseJstDate(parts[0] ?? "");
  const end = parseJstDate(parts[1] ?? "");
  return start && end && end >= start ? { start, end } : null;
}

/** @param {string} value */
function projected(value) {
  return addCalendarYears(new Date(value), 2).toISOString();
}

/** @param {string} heading */
function rewardSourceType(heading) {
  if (
    /master missions?/i.test(heading) ||
    /permanent missions?|mission duration/i.test(heading) ||
    (/missions?/i.test(heading) && /limited/i.test(heading))
  ) {
    return "MASTER_MISSION";
  }
  if (
    /event missions?|panel missions?|student council missions?|stamp rally missions?|clear missions?/i.test(
      heading,
    )
  ) {
    return "LIMITED_MISSION";
  }
  if (/login bonus/i.test(heading)) return "LOGIN_BONUS";
  if (/mana prism exchange/i.test(heading)) return "MANA_PRISM_EXCHANGE";
  if (/maintenance|compensation/i.test(heading)) return "MAINTENANCE";
  if (/challenge quest/i.test(heading)) return "CHALLENGE_QUEST";
  if (/point reward/i.test(heading)) return "POINT_REWARD";
  if (/interludes?|academy festival quests?/i.test(heading)) {
    return "QUEST_CLEAR";
  }
  if (/lottery/i.test(heading)) return "LOTTERY";
  if (
    /aniplex online|social campaign|questionnaire|survey reward/i.test(heading)
  ) {
    return "SOCIAL_CAMPAIGN";
  }
  if (/shop|exchange/i.test(heading)) return "EVENT_SHOP";
  return "OTHER";
}

/** @param {string} heading */
function isOutOfScopeAccountReward(heading) {
  return /start dash|new master|comeback|returning (?:master|player)/i.test(
    heading,
  );
}

/** @param {string} heading */
function isUnsupportedRewardTable(heading) {
  return /\b20\d{2} New Year CE\b/i.test(heading);
}

/** @param {string} wikitext */
function extractTables(wikitext) {
  const tables = [];
  const expression = /\{\|[^]*?\n\|\}/g;
  for (const match of wikitext.matchAll(expression)) {
    const index = match.index ?? 0;
    const before = wikitext.slice(0, index);
    const headings = [...before.matchAll(/^(={2,5})\s*(.+?)\s*\1\s*$/gm)];
    const latest = headings.at(-1);
    const sectionStart = latest?.index ?? Math.max(0, index - 1_500);
    const headingStack = [];
    for (const headingMatch of headings) {
      const level = headingMatch[1]?.length ?? 2;
      while ((headingStack.at(-1)?.level ?? 0) >= level) {
        headingStack.pop();
      }
      headingStack.push({
        level,
        name: plainWikitext(headingMatch[2] ?? ""),
      });
    }
    tables.push({
      body: match[0],
      heading: plainWikitext(latest?.[2] ?? "Other rewards"),
      headingPath:
        headingStack
          .map(({ name }) => name)
          .filter(Boolean)
          .join(" / ") || "Other rewards",
      prelude: before.slice(sectionStart),
    });
  }
  return tables;
}

/** @param {string} row */
function extractCells(row) {
  return extractCellDetails(row).map(({ value }) => value);
}

/** @param {string} row */
function extractCellDetails(row) {
  const normalised = row.replace(/\|\|/g, "\n|");
  const matches = [
    ...normalised.matchAll(
      /(?:^|\n)[|!](?![}|-])\s*([^]*?)(?=(?:\n[|!](?![}|-]))|$)/g,
    ),
  ];
  return matches.map((match) => {
    const raw = (match[1] ?? "").trim();
    const attributes =
      raw.match(
        /^(?:(?:rowspan|colspan|style|class|align|width)\s*=\s*(?:"[^"]*"|'[^']*'|[^|]+)\s*)+\|/i,
      )?.[0] ?? "";
    const span = attributes.match(/\browspan\s*=\s*["']?(\d+)/i);
    return {
      rowspan: span ? Number(span[1]) : 1,
      value: raw
        .replace(
          /^(?:(?:rowspan|colspan|style|class|align|width)\s*=\s*(?:"[^"]*"|'[^']*'|[^|]+)\s*)+\|/i,
          "",
        )
        .replace(/^\|\s*/, "")
        .replace(/\s*\|}\s*$/, "")
        .trim(),
    };
  });
}

/**
 * Read only explicitly labelled mission periods; claim periods are separate.
 * @param {string} value
 * @param {{start: Date, end: Date} | null} enclosing
 */
function labelledMissionPeriod(value, enclosing) {
  const text = plainWikitext(value);
  const label =
    /(?:\bmission\s+(?:duration|period|timeframe)\s*:?|\[mission\])\s*/i.exec(
      text,
    );
  if (!label) return { present: false, range: null };
  const period =
    text
      .slice(label.index + label[0].length)
      .split(
        /(?:\b(?:reward|claim|receiving)\s+(?:duration|period)\b|\[(?:reward|claim)\])/i,
      )[0] ?? "";
  let ranges = allRanges(period);
  if (!ranges.length && enclosing) {
    // One endpoint may omit its year. Never overwrite an explicit year.
    const partial = period.match(
      /^([A-Za-z]+\s+\d{1,2})(?:,?\s+(\d{4}))?\s+(\d{1,2}:\d{2})\s*[~–—]\s*([A-Za-z]+\s+\d{1,2})(?:,?\s+(\d{4}))?\s+(\d{1,2}:\d{2})(?:\s+JST)?/i,
    );
    if (partial) {
      const firstYear = new Date(
        enclosing.start.getTime() + JST_OFFSET_MILLISECONDS,
      ).getUTCFullYear();
      const lastYear = new Date(
        enclosing.end.getTime() + JST_OFFSET_MILLISECONDS,
      ).getUTCFullYear();
      if (lastYear < firstYear || lastYear - firstYear > 1) {
        return { present: true, range: null };
      }
      for (let year = firstYear; year <= lastYear; year++) {
        const start = parseJstDate(
          `${partial[1]}, ${partial[2] ?? year} ${partial[3]}`,
        );
        let end = parseJstDate(
          `${partial[4]}, ${partial[5] ?? year} ${partial[6]}`,
        );
        if (start && end && end < start && !partial[5]) {
          end = parseJstDate(`${partial[4]}, ${year + 1} ${partial[6]}`);
        }
        if (
          start &&
          end &&
          end >= start &&
          start >= enclosing.start &&
          end <= enclosing.end
        ) {
          ranges.push({ start, end });
        }
      }
    }
  }
  ranges = ranges.filter(
    ({ start, end }) =>
      !enclosing || (start >= enclosing.start && end <= enclosing.end),
  );
  const unique = new Map(
    ranges.map((range) => [
      `${range.start.toISOString()}/${range.end.toISOString()}`,
      range,
    ]),
  );
  return {
    present: true,
    range: unique.size === 1 ? ([...unique.values()][0] ?? null) : null,
  };
}

/**
 * Carry period cells only over their declared rows. Original reward cells stay
 * untouched, so adding period support does not change source identities.
 * @param {string[]} rawRows
 * @param {{start: Date, end: Date} | null} enclosing
 */
function missionPeriodsByRow(rawRows, enclosing) {
  /** @type {Array<{remaining: number, value: string}>} */
  let shared = [];
  return rawRows.map((row) => {
    const details = extractCellDetails(row);
    const texts = [
      ...shared.map(({ value }) => value),
      ...details.map(({ value }) => value),
    ];
    shared = shared
      .map((cell) => ({ ...cell, remaining: cell.remaining - 1 }))
      .filter(({ remaining }) => remaining > 0);
    for (const cell of details) {
      if (
        Number.isSafeInteger(cell.rowspan) &&
        cell.rowspan > 1 &&
        cell.rowspan <= rawRows.length &&
        labelledMissionPeriod(cell.value, enclosing).present
      ) {
        shared.push({ remaining: cell.rowspan - 1, value: cell.value });
      }
    }
    const periods = texts
      .map((text) => labelledMissionPeriod(text, enclosing))
      .filter(({ present }) => present);
    const ranges = new Map(
      periods
        .filter(({ range }) => range)
        .map(({ range }) => [
          `${range?.start.toISOString()}/${range?.end.toISOString()}`,
          range,
        ]),
    );
    return {
      present: periods.length > 0,
      range:
        periods.every(({ range }) => range) && ranges.size === 1
          ? ([...ranges.values()][0] ?? null)
          : null,
    };
  });
}

/** @param {string} cell */
function trackedRewards(cell) {
  const rewards = [];
  for (const [templateName, itemType] of TRACKED_TEMPLATES) {
    for (const template of extractTemplates(cell, templateName)) {
      const parameters = parseTemplateParameters(template);
      const amount = Number(parameters.get("1") ?? 1);
      if (Number.isSafeInteger(amount) && amount > 0) {
        rewards.push({ itemType, amount });
      }
    }
  }
  const totals = new Map();
  for (const reward of rewards) {
    totals.set(
      reward.itemType,
      (totals.get(reward.itemType) ?? 0) + reward.amount,
    );
  }
  return [...totals].map(([itemType, amount]) => ({ itemType, amount }));
}

/**
 * Extract tracked first-clear rewards from Fandom quest-footer parameters.
 * This is used only when Atlas has no safe war association for the event.
 * @param {string} wikitext
 * @param {{pageId: number, pageTitle: string, eventSourceKey: string | null, externalEventSourceKey: string | null, evidenceSourceKey: string, evidenceUrl: string, eventEndsAt: string}} options
 */
export function extractFandomQuestParameterRewards(wikitext, options) {
  const occurrences = new Map();
  return [...wikitext.matchAll(/^\|\s*reward\s*=\s*(.+)$/gim)].flatMap(
    (match) => {
      const rewardCell = match[1] ?? "";
      const rewards = trackedRewards(rewardCell);
      if (rewards.length === 0) return [];

      const before = wikitext.slice(0, match.index ?? 0);
      const heading = [...before.matchAll(/^={2,5}\s*(.+?)\s*={2,5}\s*$/gm)].at(
        -1,
      );
      const sectionName = plainWikitext(heading?.[1] ?? "Quest reward");
      const identity = rowIdentity(`${sectionName}\n${rewardCell}`);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const sourceKey = `fandom:JP:page:${options.pageId}:quest-clear:${identity}:${occurrence}:projection:NA`;

      return [
        {
          sourceKey,
          eventSourceKey: options.eventSourceKey,
          externalEventSourceKey: options.externalEventSourceKey,
          evidenceSourceKey: options.evidenceSourceKey,
          name: `${options.pageTitle}: ${sectionName}`,
          type: "QUEST_CLEAR",
          status: "PROJECTED",
          evidenceUrl: options.evidenceUrl,
          lastVerifiedAt: null,
          rewards: rewards.map((reward) => ({
            sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
            itemType: reward.itemType,
            amount: reward.amount,
            expectedAt: options.eventEndsAt,
            dateBasis: "EVENT_END",
            nature: "CONDITIONAL",
            eligibility: `Clear ${sectionName}.`,
            defaultIncluded: true,
            reviewedAt: null,
          })),
        },
      ];
    },
  );
}

/** @param {string[]} cells */
function isSummaryRow(cells) {
  return cells.some((cell) =>
    /^(?:grand\s+)?total\b/i.test(plainWikitext(cell)),
  );
}

/** @param {string} value */
function firstRange(value) {
  return allRanges(value)[0] ?? null;
}

/** @param {string} value */
function allRanges(value) {
  const normalisedValue = value.replace(
    /([A-Za-z]+\s+\d{1,2})\s+(\d{4})/g,
    "$1, $2",
  );
  const matches = [
    ...normalisedValue.matchAll(
      /([A-Za-z]+\s+\d{1,2},\s*\d{4}(?:\s+\d{1,2}:\d{2})?)\s*[~–—]\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}(?:\s+\d{1,2}:\d{2})?)(?:\s+JST)?/g,
    ),
  ];
  const ranges = [];
  for (const match of matches) {
    const range = parseJstDateRange(`${match[1]} ~ ${match[2]}`);
    if (range) ranges.push(range);
  }
  return ranges;
}

/** @param {string} value @param {number} year */
function singleDayTimeRange(value, year) {
  const match = value.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}:\d{2})\s*[~–—]\s*(\d{1,2}:\d{2})/,
  );
  if (!match) return null;
  const start = parseJstDate(`${match[1]} ${match[2]}, ${year} ${match[3]}`);
  const end = parseJstDate(`${match[1]} ${match[2]}, ${year} ${match[4]}`);
  return start && end && end >= start ? { start, end } : null;
}

/** @param {string} value @param {{start: Date, end: Date} | null} section */
function sectionBackedCalendarRange(value, section) {
  if (!section) return null;
  const match = plainWikitext(value)
    .trim()
    .match(
      /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{1,2}:\d{2})\s*[~–—]\s*([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{1,2}:\d{2})(?:\s+JST)?$/i,
    );
  if (!match) return null;
  const firstYear = new Date(
    section.start.getTime() + JST_OFFSET_MILLISECONDS,
  ).getUTCFullYear();
  const lastYear = new Date(
    section.end.getTime() + JST_OFFSET_MILLISECONDS,
  ).getUTCFullYear();
  if (lastYear < firstYear || lastYear - firstYear > 1) return null;
  const ranges = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const start = parseJstDate(`${match[1]} ${match[2]}, ${year} ${match[3]}`);
    let end = parseJstDate(`${match[4]} ${match[5]}, ${year} ${match[6]}`);
    if (start && end && end < start) {
      end = parseJstDate(`${match[4]} ${match[5]}, ${year + 1} ${match[6]}`);
    }
    if (
      start &&
      end &&
      end >= start &&
      start >= section.start &&
      end <= section.end
    )
      ranges.push({ start, end });
  }
  return ranges.length === 1 ? ranges[0] : null;
}

/** @param {string} value @param {number} year */
function partialCalendarRanges(value, year) {
  const results = [];
  const expression =
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}:\d{2})\s*[~–—]\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}:\d{2})/g;
  for (const match of value.matchAll(expression)) {
    const start = parseJstDate(`${match[1]} ${match[2]}, ${year} ${match[3]}`);
    let end = parseJstDate(`${match[4]} ${match[5]}, ${year} ${match[6]}`);
    if (start && end && end < start) {
      end = parseJstDate(`${match[4]} ${match[5]}, ${year + 1} ${match[6]}`);
    }
    if (start && end && end >= start) results.push({ start, end });
  }
  return results;
}

/**
 * Parse a compact weekly label such as `August 25-September 1`. The wiki
 * omits the year and time because the campaign establishes both.
 * @param {string} value
 * @param {string} eventSourceStartsAt
 */
function compactCalendarRange(value, eventSourceStartsAt) {
  const match = value.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s*[-–—]\s*(?:([A-Za-z]+)\s+)?(\d{1,2})$/,
  );
  if (!match) return null;
  const startMonth = MONTHS.get((match[1] ?? "").toLowerCase());
  const endMonth = MONTHS.get((match[3] ?? match[1] ?? "").toLowerCase());
  if (startMonth === undefined || endMonth === undefined) return null;

  const sourceStart = new Date(eventSourceStartsAt);
  const sourceStartJst = new Date(
    sourceStart.getTime() + JST_OFFSET_MILLISECONDS,
  );
  const startYear = sourceStartJst.getUTCFullYear();
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  const hour = sourceStartJst.getUTCHours();
  const minute = sourceStartJst.getUTCMinutes();
  const start = parseJstDate(
    `${match[1]} ${match[2]}, ${startYear} ${hour}:${String(minute).padStart(2, "0")}`,
  );
  const endBoundary = parseJstDate(
    `${match[3] ?? match[1]} ${match[4]}, ${endYear} ${hour}:${String(minute).padStart(2, "0")}`,
  );
  if (!start || !endBoundary || endBoundary < start) return null;
  return {
    start,
    end: new Date(endBoundary.getTime() - MINUTE_MILLISECONDS),
  };
}

/** @param {string} value @param {number} rewardCount */
function loginRangeForCount(value, rewardCount) {
  return (
    allRanges(value).sort((left, right) => {
      const targetDuration = rewardCount * DAY_MILLISECONDS;
      const leftDifference = Math.abs(
        left.end.getTime() - left.start.getTime() - targetDuration,
      );
      const rightDifference = Math.abs(
        right.end.getTime() - right.start.getTime() - targetDuration,
      );
      return leftDifference - rightDifference;
    })[0] ?? null
  );
}

/** @param {string} value */
function rowIdentity(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** @param {string} value */
function positiveInteger(value) {
  const match = plainWikitext(value).match(/^\d[\d,]*/);
  const parsed = Number((match?.[0] ?? "").replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** @param {string} value */
function tableCellLabel(value) {
  const plain = plainWikitext(value);
  if (plain) return plain;
  const templateName = value.match(/\{\{\s*([^|}\n]+)/)?.[1];
  return templateName ? plainWikitext(templateName) : "";
}

/** @param {string} itemType @param {number} amount */
function rewardLabel(itemType, amount) {
  const labels = /** @type {Record<string, string>} */ ({
    SAINT_QUARTZ: "Saint Quartz",
    SAINT_QUARTZ_FRAGMENT: "Saint Quartz Fragments",
    SUMMON_TICKET: "Summon Tickets",
    CRYSTALLIZED_LORE: "Crystallised Lores",
    HOLY_GRAIL: "Holy Grails",
  });
  return `${amount} ${labels[itemType] ?? itemType}`;
}

/**
 * @param {string} wikitext
 * @param {{pageId: number, eventSourceKey: string, evidenceSourceKey: string, evidenceUrl: string, eventEndsAt: string}} options
 */
function extractMaintenanceProse(wikitext, options) {
  const results = [];
  const headings = [...wikitext.matchAll(/^={2,5}\s*(.+?)\s*={2,5}\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const headingMatch = headings[index];
    const heading = plainWikitext(headingMatch?.[1] ?? "");
    if (!/maintenance|compensation/i.test(heading)) continue;
    const start = (headingMatch?.index ?? 0) + (headingMatch?.[0].length ?? 0);
    const end = headings[index + 1]?.index ?? wikitext.length;
    const section = wikitext.slice(start, end).replace(/\{\|[^]*?\n\|\}/g, "");
    const rewards = trackedRewards(section);
    if (rewards.length === 0) continue;
    const relevantLine =
      section.split("\n").find((line) => trackedRewards(line).length > 0) ??
      heading;
    const context = plainWikitext(relevantLine) || heading;
    const targeted = /eligible|affected|players? who|masters? who|only/i.test(
      context,
    );
    const range = firstRange(section);
    const identity = rowIdentity(`${heading}\n${context}`);
    const sourceKey = `fandom:JP:page:${options.pageId}:maintenance:${identity}:projection:NA`;
    results.push({
      sourceKey,
      eventSourceKey: options.eventSourceKey,
      evidenceSourceKey: options.evidenceSourceKey,
      name: `${heading}: ${context}`,
      type: "MAINTENANCE",
      status: "PROJECTED",
      evidenceUrl: options.evidenceUrl,
      lastVerifiedAt: null,
      rewards: rewards.map((reward) => ({
        sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
        itemType: reward.itemType,
        amount: reward.amount,
        expectedAt: range
          ? addCalendarYears(range.end, 2).toISOString()
          : options.eventEndsAt,
        dateBasis: range ? "ABSOLUTE" : "UNKNOWN",
        nature: targeted ? "CONDITIONAL" : "DETERMINISTIC",
        eligibility: targeted ? context : null,
        defaultIncluded: !targeted,
        reviewedAt: null,
      })),
    });
  }
  return results;
}

/**
 * @param {string} wikitext
 * @param {{pageId: number, eventName: string, eventSourceStartsAt: string, eventSourceEndsAt?: string, eventSourceKey: string, evidenceSourceKey: string, evidenceUrl: string, eventEndsAt: string}} options
 */
export function extractFandomRewardSources(wikitext, options) {
  /** @param {{start: Date, end: Date} | null | undefined} range */
  const coversEventPeriod = (range) =>
    Boolean(
      range &&
      options.eventSourceEndsAt &&
      range.start.toISOString() === options.eventSourceStartsAt &&
      range.end.toISOString() === options.eventSourceEndsAt,
    );
  const rewardSources = [];
  const issues = [];
  const dateWarnings = new Set();
  const heldTableWarnings = new Set();
  const loginTableOccurrences = new Map();
  const sourceIdentityOccurrences = new Map();

  for (const table of extractTables(wikitext)) {
    if (isOutOfScopeAccountReward(table.headingPath)) {
      issues.push({
        sourceKey: `fandom:JP:page:${options.pageId}:excluded:${stableSlug(table.heading)}`,
        severity: "INFO",
        message: `${table.heading} was not imported because new-player and returning-player rewards are out of scope.`,
      });
      continue;
    }
    if (isUnsupportedRewardTable(table.headingPath)) {
      issues.push({
        sourceKey: `fandom:JP:page:${options.pageId}:excluded:${stableSlug(table.headingPath)}`,
        severity: "INFO",
        message: `${table.heading} was not imported because the table describes Craft Essence availability rather than player income.`,
      });
      continue;
    }
    const headingType = rewardSourceType(
      `${options.eventName}\n${table.headingPath}\n${table.prelude.slice(0, 500)}`,
    );
    const parsedSectionRange = firstRange(table.prelude);
    const sourceStart = new Date(options.eventSourceStartsAt);
    const sourceEnd = options.eventSourceEndsAt
      ? new Date(options.eventSourceEndsAt)
      : null;
    const invalidExchangePeriod =
      headingType === "MANA_PRISM_EXCHANGE" &&
      parsedSectionRange &&
      sourceEnd &&
      (parsedSectionRange.start < sourceStart ||
        parsedSectionRange.end > sourceEnd);
    const sectionRange = invalidExchangePeriod ? null : parsedSectionRange;
    if (invalidExchangePeriod) {
      dateWarnings.add(
        `${table.heading} has an out-of-event exchange period. The projected event end date was used pending review.`,
      );
    }
    const dailyLoginSection =
      headingType === "LOGIN_BONUS" && allRanges(table.prelude).length === 1
        ? sectionRange
        : null;
    const rawRows = table.body.split(/\n\|-\s*\n/).slice(1);
    const enclosingPeriod = options.eventSourceEndsAt
      ? {
          start: new Date(options.eventSourceStartsAt),
          end: new Date(options.eventSourceEndsAt),
        }
      : null;
    const missionPeriods = missionPeriodsByRow(rawRows, enclosingPeriod);
    const sectionMissionPeriod = labelledMissionPeriod(
      table.prelude,
      enclosingPeriod,
    );
    const parsedRows = rawRows.map((row, index) => ({
      row,
      cells: extractCells(row),
      missionPeriod: missionPeriods[index],
    }));
    const hasDetailedRewards = parsedRows.some(
      ({ cells }) =>
        !isSummaryRow(cells) &&
        cells.some((cell) => trackedRewards(cell).length > 0),
    );
    const rows = hasDetailedRewards
      ? parsedRows.filter(({ cells }) => !isSummaryRow(cells))
      : parsedRows;
    const consumedMatrixRows = new Set();
    if (headingType === "MASTER_MISSION") {
      let periodLabel = "Mission period";
      let missionRange = sectionRange;
      /** @type {string | null} */
      let missionScope =
        extractCells(table.body.split(/\n\|-/)[0] ?? "")
          .map(plainWikitext)
          .find((cell) => /^(?:act|clear|complete)\b/i.test(cell)) ?? null;
      /** @type {{rowIndex: number, targets: Array<number | null>} | null} */
      let targetRow = null;
      /** @type {{rowIndex: number, targets: Array<number | null>} | null} */
      let datedTargetRow = null;
      /**
       * @param {string[]} rewardCells
       * @param {Array<number | null>} targets
       * @param {string} label
       * @param {{start: Date, end: Date} | null} range
       * @param {number} rowIndex
       */
      const appendMissionMatrixRewards = (
        rewardCells,
        targets,
        label,
        range,
        rowIndex,
      ) => {
        rewardCells.forEach((rewardCell, rewardIndex) => {
          const rewards = trackedRewards(rewardCell);
          const target = targets[rewardIndex];
          if (rewards.length === 0 || !target) return;
          const identity = rowIdentity(
            `${table.heading}\n${label}\n${range?.start.toISOString() ?? "unknown"}\n${target}\n${rewardCell}\n${rowIndex}:${rewardIndex}`,
          );
          const sourceKey = `fandom:JP:page:${options.pageId}:${stableSlug(table.heading)}:mission-matrix:${identity}:projection:NA`;
          const expectedAt = range
            ? addCalendarYears(range.end, 2).toISOString()
            : options.eventEndsAt;
          const condition = missionScope
            ? `Complete ${target} qualifying tasks. Mission scope: ${missionScope}`
            : `Complete ${target} qualifying tasks during ${label}.`;
          const isPermanentMission = /permanent/i.test(table.headingPath);
          rewardSources.push({
            sourceKey,
            eventSourceKey: options.eventSourceKey,
            evidenceSourceKey: options.evidenceSourceKey,
            name: `${table.heading}: ${label}, target ${target}`,
            type: headingType,
            status: "PROJECTED",
            evidenceUrl: options.evidenceUrl,
            lastVerifiedAt: null,
            rewards: rewards.map((reward) => ({
              sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
              itemType: reward.itemType,
              amount: reward.amount,
              expectedAt,
              dateBasis:
                !isPermanentMission && (!range || coversEventPeriod(range))
                  ? "EVENT_END"
                  : "UNKNOWN",
              nature: "CONDITIONAL",
              eligibility: condition,
              defaultIncluded: !isPermanentMission,
              reviewedAt: null,
            })),
          });
        });
      };
      for (const [rowIndex, { cells }] of rows.entries()) {
        const plainCells = cells.map(plainWikitext);
        const firstCell = plainCells[0] ?? "";
        const rowText = plainCells.join(" ");
        const rowRange = firstRange(rowText);
        if (/^week\s+\d+/i.test(firstCell)) periodLabel = firstCell;
        if (/mission duration/i.test(rowText) && rowRange) {
          missionRange = rowRange;
        }
        if (
          /^(?:act|clear|complete)\b/i.test(firstCell) &&
          !cells.some((cell) => trackedRewards(cell).length > 0)
        ) {
          missionScope = firstCell;
        }
        const targets = plainCells.slice(1).map(positiveInteger);
        const datedTargets = plainCells.slice(2).map(positiveInteger);
        if (
          /^date$/i.test(firstCell) &&
          /^times?$/i.test(plainCells[1] ?? "") &&
          datedTargets.length > 0 &&
          datedTargets.every((target) => target !== null)
        ) {
          datedTargetRow = { rowIndex, targets: datedTargets };
          continue;
        }
        const compactRange = compactCalendarRange(
          firstCell,
          options.eventSourceStartsAt,
        );
        if (
          datedTargetRow &&
          compactRange &&
          /^rewards?$/i.test(plainCells[1] ?? "")
        ) {
          const rewardCells = cells.slice(2);
          if (rewardCells.length === datedTargetRow.targets.length) {
            consumedMatrixRows.add(datedTargetRow.rowIndex);
            consumedMatrixRows.add(rowIndex);
            appendMissionMatrixRewards(
              rewardCells,
              datedTargetRow.targets,
              firstCell,
              compactRange,
              rowIndex,
            );
          }
          continue;
        }
        if (
          /^times?$/i.test(firstCell) &&
          targets.length > 0 &&
          targets.every((target) => target !== null)
        ) {
          targetRow = { rowIndex, targets };
          continue;
        }
        if (!targetRow || !/^rewards?$/i.test(firstCell)) continue;

        const rewardCells = cells.slice(1);
        if (rewardCells.length !== targetRow.targets.length) {
          targetRow = null;
          continue;
        }
        consumedMatrixRows.add(targetRow.rowIndex);
        consumedMatrixRows.add(rowIndex);
        appendMissionMatrixRewards(
          rewardCells,
          targetRow.targets,
          periodLabel,
          missionRange,
          rowIndex,
        );
        targetRow = null;
      }
    }
    const loginCountRows = rows.flatMap(({ cells }) => {
      if (
        !/^(?:login (?:count|days?)|day)$/i.test(plainWikitext(cells[0] ?? ""))
      ) {
        return [];
      }
      return cells.slice(1).map((cell) => positiveInteger(cell) ?? 0);
    });
    const fallbackLoginRewardCount = rows.reduce(
      (count, { cells }) =>
        /^(?:rewards?|present)$/i.test(plainWikitext(cells[0] ?? ""))
          ? count + cells.slice(1).length
          : count,
      0,
    );
    const maximumLoginCount = Math.max(
      fallbackLoginRewardCount,
      ...loginCountRows,
    );
    const tableLoginRange =
      headingType === "LOGIN_BONUS"
        ? loginRangeForCount(table.prelude, maximumLoginCount)
        : null;
    const loginSourceYear = new Date(
      (tableLoginRange?.start ?? sourceStart).getTime() +
        JST_OFFSET_MILLISECONDS,
    ).getUTCFullYear();
    const loginCalendarRanges =
      headingType === "LOGIN_BONUS"
        ? partialCalendarRanges(table.body, loginSourceYear)
        : [];
    const loginRequirementMatch = table.prelude.match(
      /(?:'''Requirements?'''|Requirements?)\s*:\s*([^\n]+)/i,
    );
    const loginRequirement = loginRequirementMatch
      ? plainWikitext(loginRequirementMatch[1] ?? "")
      : null;
    const loginTableOccurrence =
      headingType === "LOGIN_BONUS"
        ? (loginTableOccurrences.get(table.heading) ?? 0) + 1
        : 0;
    if (headingType === "LOGIN_BONUS") {
      loginTableOccurrences.set(table.heading, loginTableOccurrence);
    }
    const loginMatrixSuffix =
      loginTableOccurrence <= 1 ? "" : `:matrix-${loginTableOccurrence}`;
    /** @type {Array<number | null> | null} */
    let pendingLoginCounts = null;
    let fallbackLoginCount = 0;
    let interludeSubject = null;
    for (const [rowIndex, { cells, missionPeriod }] of rows.entries()) {
      if (consumedMatrixRows.has(rowIndex)) continue;
      if (
        headingType === "LOGIN_BONUS" &&
        /^(?:login (?:count|days?)|day)$/i.test(plainWikitext(cells[0] ?? ""))
      ) {
        pendingLoginCounts = cells.slice(1).map(positiveInteger);
        continue;
      }
      if (
        headingType === "LOGIN_BONUS" &&
        /^(?:rewards?|present)$/i.test(plainWikitext(cells[0] ?? ""))
      ) {
        const loginCells = cells.slice(1);
        const counts =
          pendingLoginCounts?.length === loginCells.length
            ? pendingLoginCounts
            : loginCells.map((_, index) => fallbackLoginCount + index + 1);
        loginCells.forEach((cell, loginIndex) => {
          const rewards = trackedRewards(cell);
          if (rewards.length === 0) return;
          const day = counts[loginIndex];
          if (!day) return;
          const sourceKey = `fandom:JP:page:${options.pageId}:${stableSlug(table.heading)}${loginMatrixSuffix}:day-${day}:projection:NA`;
          const sourceDate =
            loginCalendarRanges[day - 1]?.start ??
            (tableLoginRange
              ? new Date(
                  tableLoginRange.start.getTime() +
                    (day - 1) * DAY_MILLISECONDS,
                )
              : null);
          rewardSources.push({
            sourceKey,
            eventSourceKey: options.eventSourceKey,
            evidenceSourceKey: options.evidenceSourceKey,
            name: `${table.heading}: login ${day}`,
            type: headingType,
            status: "PROJECTED",
            evidenceUrl: options.evidenceUrl,
            lastVerifiedAt: null,
            rewards: rewards.map((reward) => ({
              sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
              itemType: reward.itemType,
              amount: reward.amount,
              expectedAt: sourceDate
                ? addCalendarYears(sourceDate, 2).toISOString()
                : options.eventEndsAt,
              dateBasis: sourceDate ? "START_RELATIVE" : "EVENT_END",
              nature: "CONDITIONAL",
              eligibility: loginRequirement
                ? `Log in for day ${day}. Requirement: ${loginRequirement}.`
                : `Log in for day ${day}.`,
              defaultIncluded: true,
              reviewedAt: null,
            })),
          });
          if (!sourceDate) {
            dateWarnings.add(
              `${table.heading} has no parseable reward date. The projected event end date was used.`,
            );
          }
        });
        fallbackLoginCount = Math.max(
          fallbackLoginCount,
          ...counts.map((count) => count ?? 0),
        );
        pendingLoginCounts = null;
        continue;
      }
      const rewardCellIndexes = cells.flatMap((cell, index) =>
        trackedRewards(cell).length > 0 ? [index] : [],
      );
      const selectedRewardCellIndexes =
        headingType === "MANA_PRISM_EXCHANGE"
          ? rewardCellIndexes.slice(0, 1)
          : rewardCellIndexes;
      for (const rewardCellIndex of selectedRewardCellIndexes) {
        const rewardCell = cells[rewardCellIndex];
        if (!rewardCell) continue;
        let rewards = trackedRewards(rewardCell);
        const contextCell =
          cells
            .slice(0, rewardCellIndex)
            .reverse()
            .find((cell) => trackedRewards(cell).length === 0) ??
          cells
            .slice(rewardCellIndex + 1)
            .find((cell) => trackedRewards(cell).length === 0) ??
          table.heading;
        let eligibility = plainWikitext(contextCell) || table.heading;
        const identityEligibility = eligibility;
        const type =
          headingType === "OTHER"
            ? rewardSourceType(`${table.headingPath}\n${eligibility}`)
            : headingType;
        if (type === "OTHER") {
          heldTableWarnings.add(
            `${table.heading} contains tracked item templates but its section does not identify a supported reward source. No reward was generated.`,
          );
          continue;
        }
        let sourceName = `${table.heading}: ${eligibility}`;
        if (
          ["LIMITED_MISSION", "MASTER_MISSION"].includes(type) &&
          rewardCellIndex >= 2
        ) {
          const missionIdentifier = plainWikitext(cells[0] ?? "");
          if (/^\d+$/.test(missionIdentifier)) {
            sourceName = `${table.heading}: mission ${missionIdentifier} — ${eligibility}`;
            eligibility = /^\?+$/.test(eligibility)
              ? `Complete mission ${missionIdentifier}; its requirements have not been published.`
              : `Complete mission ${missionIdentifier}: ${eligibility}.`;
          }
        }
        const isInterludeReward =
          type === "QUEST_CLEAR" && /interludes?/i.test(table.headingPath);
        if (isInterludeReward) {
          if (rewardCellIndex >= 2) {
            interludeSubject = tableCellLabel(cells[0] ?? "") || null;
          }
          const questName = tableCellLabel(
            cells[rewardCellIndex - 1] ?? "Interlude",
          );
          const requirement = tableCellLabel(cells[rewardCellIndex + 1] ?? "");
          const subject = interludeSubject || "Servant";
          sourceName = `${subject}: ${questName}`;
          eligibility = requirement
            ? `Complete ${subject} ${questName}. Requirement: ${requirement}.`
            : `Complete ${subject} ${questName}.`;
        }
        if (type === "MANA_PRISM_EXCHANGE") {
          const tradeCount = positiveInteger(cells[rewardCellIndex + 1] ?? "");
          const costEach = positiveInteger(cells[rewardCellIndex + 2] ?? "");
          const totalCost = positiveInteger(cells[rewardCellIndex + 3] ?? "");
          if (tradeCount) {
            rewards = rewards.map((reward) => ({
              ...reward,
              amount: reward.amount * tradeCount,
            }));
          }
          const rewardSummary = rewards
            .map((reward) => rewardLabel(reward.itemType, reward.amount))
            .join(" and ");
          eligibility = totalCost
            ? `Exchange ${totalCost} Mana Prisms for ${rewardSummary}.`
            : costEach && tradeCount
              ? `Exchange ${costEach} Mana Prisms ${tradeCount} times for ${rewardSummary}.`
              : `Exchange Mana Prisms for ${rewardSummary}.`;
        } else if (type === "LOGIN_BONUS") {
          eligibility = `Log in during ${eligibility}.`;
        }
        const rowRange =
          firstRange(contextCell) ??
          sectionBackedCalendarRange(contextCell, dailyLoginSection) ??
          singleDayTimeRange(
            contextCell,
            new Date(
              sourceStart.getTime() + JST_OFFSET_MILLISECONDS,
            ).getUTCFullYear(),
          );
        const missionDate = ["LIMITED_MISSION", "MASTER_MISSION"].includes(type)
          ? missionPeriod?.present
            ? missionPeriod
            : sectionMissionPeriod
          : null;
        const effectiveRange = missionDate?.present
          ? missionDate.range
          : (sectionRange ?? rowRange);
        const expectedSourceDate = missionDate?.present
          ? missionDate.range?.end
          : type === "LOGIN_BONUS"
            ? rowRange?.start
            : (sectionRange?.end ?? rowRange?.end);
        const expectedAt = expectedSourceDate
          ? addCalendarYears(expectedSourceDate, 2).toISOString()
          : options.eventEndsAt;
        const baseIdentity = rowIdentity(
          `${table.heading}\n${identityEligibility}\n${rewardCellIndex}`,
        );
        const identityOccurrence =
          (sourceIdentityOccurrences.get(baseIdentity) ?? 0) + 1;
        sourceIdentityOccurrences.set(baseIdentity, identityOccurrence);
        const identity =
          identityOccurrence === 1
            ? baseIdentity
            : `${baseIdentity}-${rowIdentity(cells.join("\n"))}`;
        const sourceKey = `fandom:JP:page:${options.pageId}:${stableSlug(table.heading)}:${identity}:projection:NA`;
        const isMaintenance = type === "MAINTENANCE";
        const isPermanentMission =
          type === "MASTER_MISSION" && /permanent/i.test(table.headingPath);
        const isPermanentQuestReward =
          type === "QUEST_CLEAR" &&
          /interludes?|strengthening/i.test(table.headingPath);
        if (type === "SOCIAL_CAMPAIGN" && table.heading === "Other rewards") {
          sourceName = `${options.eventName}: questionnaire completion`;
        }
        rewardSources.push({
          sourceKey,
          eventSourceKey: options.eventSourceKey,
          evidenceSourceKey: options.evidenceSourceKey,
          name: sourceName,
          type,
          status: "PROJECTED",
          evidenceUrl: options.evidenceUrl,
          lastVerifiedAt: null,
          rewards: rewards.map((reward) => ({
            sourceKey: `${sourceKey}:${reward.itemType.toLowerCase()}`,
            itemType: reward.itemType,
            amount: reward.amount,
            expectedAt,
            dateBasis:
              isPermanentMission || invalidExchangePeriod
                ? "UNKNOWN"
                : type !== "LOGIN_BONUS" &&
                    !isMaintenance &&
                    coversEventPeriod(effectiveRange)
                  ? "EVENT_END"
                  : expectedSourceDate
                    ? type === "LOGIN_BONUS"
                      ? "START_RELATIVE"
                      : "UNKNOWN"
                    : isMaintenance
                      ? "UNKNOWN"
                      : "EVENT_END",
            nature: isMaintenance ? "DETERMINISTIC" : "CONDITIONAL",
            eligibility: isMaintenance ? null : eligibility,
            defaultIncluded:
              !isPermanentMission &&
              !isPermanentQuestReward &&
              !invalidExchangePeriod,
            reviewedAt: null,
          })),
        });
        if (!expectedSourceDate) {
          dateWarnings.add(
            missionDate?.present
              ? `${table.heading} has an ambiguous, invalid or out-of-event mission period. The projected event end date was used.`
              : `${table.heading} has no parseable reward date. The projected event end date was used.`,
          );
        }
      }
    }
  }

  rewardSources.push(...extractMaintenanceProse(wikitext, options));
  for (const message of dateWarnings) {
    issues.push({
      sourceKey: `fandom:JP:page:${options.pageId}:date-review:${rowIdentity(message)}`,
      severity: "WARNING",
      message,
    });
  }
  for (const message of heldTableWarnings) {
    issues.push({
      sourceKey: `fandom:JP:page:${options.pageId}:unsupported-reward-table:${rowIdentity(message)}`,
      severity: "WARNING",
      message,
    });
  }
  return { rewardSources, issues };
}

/** @param {string} value */
function eventTypeFromHeader(value) {
  const type = value.toLowerCase();
  if (type.includes("login")) return "LOGIN_BONUS";
  if (type.includes("main story") || type.includes("mainstory")) {
    return "QUEST_RELEASE";
  }
  if (type.includes("campaign")) return "CAMPAIGN";
  return "MAIN_EVENT";
}

/** @param {string} wikitext */
export function parseFandomEventHeader(wikitext) {
  const headerBody = extractNestedTemplates(wikitext, "EventHeaderJP")[0];
  if (!headerBody) return null;
  const parameters = parseTemplateParameters(headerBody);
  const start = parseJstDate(parameters.get("start") ?? "");
  const end = parseJstDate(
    parameters.get("end")?.trim() || parameters.get("displayend")?.trim() || "",
  );
  return {
    name: parameters.get("pagename")?.trim() || null,
    sourceType: parameters.get("type")?.trim() || null,
    startsAt: start?.toISOString() ?? null,
    endsAt: end?.toISOString() ?? null,
  };
}

/**
 * @param {{pageId: number, title: string, revisionId: number, revisionTimestamp: string, wikitext: string, contentHash: string, url: string}} page
 * @param {{name: string, type: string, startsAt: string, endsAt: string}} listEntry
 * @param {{retrievedAt: string}} options
 */
export function normaliseFandomCampaign(page, listEntry, options) {
  const header = parseFandomEventHeader(page.wikitext);
  const sourceStart = header?.startsAt ? new Date(header.startsAt) : null;
  const parsedSourceEnd = header?.endsAt ? new Date(header.endsAt) : null;
  const sourceStartsAt = sourceStart?.toISOString() ?? listEntry.startsAt;
  const fallbackEnd = new Date(listEntry.endsAt);
  const sameFallbackDay =
    sourceStart &&
    sourceStart.toISOString().slice(0, 10) ===
      fallbackEnd.toISOString().slice(0, 10);
  const sourceEnd =
    parsedSourceEnd ?? (sameFallbackDay ? sourceStart : fallbackEnd);
  const sourceEndsAt = sourceEnd.toISOString();
  const eventSourceKey = `fandom:JP:page:${page.pageId}:projection:NA`;
  const familySourceKey = `${eventSourceKey}:family`;
  const evidenceSourceKey = `fandom:JP:page:${page.pageId}`;
  const type =
    listEntry.type === "PRE_RELEASE_CAMPAIGN" ||
    listEntry.type === "QUEST_RELEASE"
      ? listEntry.type
      : header
        ? eventTypeFromHeader(header.sourceType ?? "")
        : listEntry.type;
  const issues = [];

  if (!header) {
    issues.push({
      sourceKey: `${evidenceSourceKey}:header-review`,
      severity: "WARNING",
      message: `${page.title} has no EventHeaderJP template. Event-list dates were used.`,
    });
  } else if (!sourceStart || !parsedSourceEnd) {
    issues.push({
      sourceKey: `${evidenceSourceKey}:header-date-review`,
      severity: "WARNING",
      message: `${page.title} has incomplete EventHeaderJP dates. Event-list dates were used where needed.`,
    });
  }

  const event = {
    sourceKey: eventSourceKey,
    familySourceKey,
    evidenceSourceKey,
    name: header?.name || listEntry.name,
    type,
    startsAt: projected(sourceStartsAt),
    startsAtPrecision: "DATE_ONLY",
    endsAt: projected(sourceEndsAt),
    endsAtPrecision: "DATE_ONLY",
    status: "PROJECTED",
    sourceUrl: page.url,
    sourceRegion: "JP",
    sourceStartsAt,
    sourceEndsAt,
    projectionMethod: "TWO_CALENDAR_YEARS",
    lastSyncedAt: options.retrievedAt,
    sourceContentHash: page.contentHash,
  };
  const extracted = extractFandomRewardSources(page.wikitext, {
    pageId: page.pageId,
    eventName: page.title,
    eventSourceStartsAt: sourceStartsAt,
    eventSourceEndsAt: sourceEndsAt,
    eventSourceKey,
    evidenceSourceKey,
    evidenceUrl: page.url,
    eventEndsAt: event.endsAt,
  });

  return {
    source: {
      sourceKey: evidenceSourceKey,
      type: "WIKI",
      region: "JP",
      url: page.url,
      retrievedAt: options.retrievedAt,
      contentHash: page.contentHash,
    },
    family: {
      sourceKey: familySourceKey,
      name: event.name,
      artworkUrl: null,
      artworkSourceUrl: page.url,
      artworkAlt: `${event.name} campaign artwork`,
      artworkReviewedAt: null,
    },
    event,
    rewardSources: extracted.rewardSources,
    issues: [...issues, ...extracted.issues],
    revision: {
      id: page.revisionId,
      timestamp: page.revisionTimestamp,
    },
  };
}
