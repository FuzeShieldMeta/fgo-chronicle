import { z } from "zod";

import { normalizeAtlasEvent } from "./atlas-event-adapter.mjs";

export const ATLAS_JP_EVENT_EXPORT_URL =
  "https://api.atlasacademy.io/export/JP/nice_event_lang_en.json";
export const RECENT_UPDATE_DAYS = 90;
const DAY_SECONDS = 24 * 60 * 60;
const PERMANENT_RECORD_DAYS = 366;
const WINDOW_OVERLAP_DAYS = 90;

const atlasEventSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.string().min(1),
    name: z.string().min(1),
    originalName: z.string().nullable().optional(),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive(),
    warIds: z.array(z.number().int().positive()).default([]),
    rewards: z.array(z.unknown()).default([]),
    missions: z.array(z.unknown()).default([]),
    shop: z.array(z.unknown()).default([]),
    lotteries: z.array(z.unknown()).default([]),
  })
  .passthrough()
  .refine(({ startedAt, endedAt }) => endedAt >= startedAt, {
    message: "An Atlas event cannot end before it starts.",
    path: ["endedAt"],
  });

const atlasEventExportSchema = z.array(atlasEventSchema).min(1);

/** @param {unknown} value */
export function parseAtlasEventExport(value) {
  return atlasEventExportSchema.parse(value);
}

/**
 * Add calendar years while keeping the UTC month, time, and the nearest valid
 * day of that month.
 * @param {Date} value
 * @param {number} years
 */
export function addCalendarYears(value, years) {
  const result = new Date(value);
  const month = value.getUTCMonth();
  const day = value.getUTCDate();

  result.setUTCDate(1);
  result.setUTCFullYear(value.getUTCFullYear() + years);
  result.setUTCMonth(month);

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), month + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** @param {number} value */
function dateFromUnix(value) {
  return new Date(value * 1000);
}

/** @param {{startedAt: number, endedAt: number}} event */
function isPermanentRecord(event) {
  return event.endedAt - event.startedAt > PERMANENT_RECORD_DAYS * DAY_SECONDS;
}

/** @param {unknown} value */
function projectIso(value) {
  if (!value) return null;
  return addCalendarYears(new Date(String(value)), 2).toISOString();
}

/** @param {{type: string, name: string, originalName?: string | null, startedAt: number, endedAt: number}} event */
export function classifyAtlasScheduleEvent(event) {
  if (!new Set(["eventQuest", "fortuneCampaign"]).has(event.type)) {
    return null;
  }

  const label = `${event.name} ${event.originalName ?? ""}`;
  if (
    /攻撃威力.*アップ|無料10回召喚.*(?:回数|増加)|タイトル画面.*特殊な演出/i.test(
      label,
    )
  ) {
    return null;
  }
  if (isPermanentRecord(event)) return "QUEST_RELEASE";
  if (event.type === "fortuneCampaign" || /login bonus|ログインボーナス/i.test(label)) {
    return "LOGIN_BONUS";
  }
  if (/pre[- ]?release|開幕直前|直前キャンペーン/i.test(label)) {
    return "PRE_RELEASE_CAMPAIGN";
  }
  if (/limited mission|限定ミッション/i.test(label)) {
    return "LIMITED_MISSION";
  }
  if (/shop|ショップ/i.test(label)) return "EVENT_SHOP";
  if (/trial quest|体験クエスト/i.test(label)) return "QUEST_RELEASE";
  if (/campaign|キャンペーン/i.test(label)) return "CAMPAIGN";
  return "MAIN_EVENT";
}

/**
 * @param {Array<z.infer<typeof atlasEventSchema>>} events
 * @param {Date} asOf
 */
export function selectRollingJpEvents(events, asOf) {
  const sourceFrom = addCalendarYears(asOf, -2).getTime();
  const sourceTo = asOf.getTime();
  const overlapFrom =
    sourceFrom - WINDOW_OVERLAP_DAYS * DAY_SECONDS * 1_000;

  return events.filter((event) => {
    if (!classifyAtlasScheduleEvent(event)) return false;
    const startsAt = dateFromUnix(event.startedAt).getTime();
    const endsAt = dateFromUnix(event.endedAt).getTime();
    const startsInsideWindow = startsAt >= sourceFrom;
    const overlapsWindowStart =
      !isPermanentRecord(event) &&
      startsAt >= overlapFrom &&
      endsAt >= sourceFrom;
    return startsAt <= sourceTo && (startsInsideWindow || overlapsWindowStart);
  });
}

/**
 * @param {Record<string, any>} event
 * @param {Date} asOf
 */
export function isMutableSourceEvent(event, asOf) {
  if (!event.sourceEndsAt) return true;
  const mutableFrom = new Date(
    asOf.getTime() - RECENT_UPDATE_DAYS * 24 * 60 * 60 * 1000,
  );
  return new Date(event.sourceEndsAt) >= mutableFrom;
}

/** @param {Date | string | null | undefined} value */
function comparableDate(value) {
  return value ? new Date(value).toISOString() : null;
}

/** @param {Record<string, any>} event */
function eventSignature(event) {
  return JSON.stringify({
    name: event.name,
    type: event.type,
    startsAt: comparableDate(event.startsAt),
    endsAt: comparableDate(event.endsAt),
    sourceStartsAt: comparableDate(event.sourceStartsAt),
    sourceEndsAt: comparableDate(event.sourceEndsAt),
    sourceUrl: event.sourceUrl ?? null,
    sourceRegion: event.sourceRegion,
    projectionMethod: event.projectionMethod ?? null,
  });
}

/**
 * Plan the database changes without changing either input.
 * The caller must limit existing events to the current rolling source window.
 * @param {Array<Record<string, any>>} candidates
 * @param {Array<Record<string, any>>} existingEvents
 * @param {Date} asOf
 */
export function planEventReconciliation(candidates, existingEvents, asOf) {
  const existingByKey = new Map(
    existingEvents.map((event) => [event.sourceKey, event]),
  );
  const candidateKeys = new Set(candidates.map(({ sourceKey }) => sourceKey));
  const plan = /** @type {{
    inserts: Array<Record<string, any>>,
    updates: Array<Record<string, any>>,
    frozenDifferences: Array<Record<string, any>>,
    protectedDifferences: Array<Record<string, any>>,
    unchangedMutable: Array<Record<string, any>>,
    unchangedFrozen: Array<Record<string, any>>,
    missingSourceKeys: string[]
  }} */ ({
    inserts: [],
    updates: [],
    frozenDifferences: [],
    protectedDifferences: [],
    unchangedMutable: [],
    unchangedFrozen: [],
    missingSourceKeys: existingEvents
      .filter(({ sourceKey }) => !candidateKeys.has(sourceKey))
      .map(({ sourceKey }) => sourceKey),
  });

  for (const candidate of candidates) {
    const existing = existingByKey.get(candidate.sourceKey);
    if (!existing) {
      plan.inserts.push(candidate);
      continue;
    }

    const changed = eventSignature(candidate) !== eventSignature(existing);
    const mutable = isMutableSourceEvent(candidate, asOf);
    if (existing.status !== "PROJECTED") {
      if (changed) plan.protectedDifferences.push(candidate);
    } else if (changed && mutable) {
      plan.updates.push(candidate);
    } else if (changed) {
      plan.frozenDifferences.push(candidate);
    } else if (mutable) {
      plan.unchangedMutable.push(candidate);
    } else {
      plan.unchangedFrozen.push(candidate);
    }
  }

  return plan;
}

/** @param {string} key */
function projectedKey(key) {
  return `${key}:projection:NA`;
}

/**
 * @param {Array<z.infer<typeof atlasEventSchema>>} rawEvents
 * @param {{asOf: Date, contentHash: string, retrievedAt: string}} options
 */
export function buildProjectedEventDataset(rawEvents, options) {
  const selected = selectRollingJpEvents(rawEvents, options.asOf);
  const normalized = selected.map((raw) => {
    const scheduleRaw = isPermanentRecord(raw)
      ? { ...raw, endedAt: raw.startedAt }
      : raw;
    const family = {
      sourceKey: `atlas:JP:event:${raw.id}:family`,
      name: raw.name,
    };
    const result = normalizeAtlasEvent(scheduleRaw, {
      region: "JP",
      retrievedAt: options.retrievedAt,
      contentHash: options.contentHash,
      family,
    });
    const eventSourceKey = projectedKey(result.event.sourceKey);
    const familySourceKey = projectedKey(result.family.sourceKey);
    const eventType = classifyAtlasScheduleEvent(raw);

    return {
      source: result.source,
      family: {
        ...result.family,
        sourceKey: familySourceKey,
      },
      event: {
        ...result.event,
        sourceKey: eventSourceKey,
        familySourceKey,
        type: eventType,
        startsAt: projectIso(result.event.startsAt),
        endsAt: projectIso(result.event.endsAt),
        status: "PROJECTED",
        sourceStartsAt: result.event.startsAt,
        sourceEndsAt: result.event.endsAt,
        projectionMethod: "TWO_CALENDAR_YEARS",
        lastSyncedAt: options.retrievedAt,
        sourceContentHash: options.contentHash,
      },
      rewardSources: result.rewardSources.map((source) => {
        const sourceKey = projectedKey(source.sourceKey);
        return {
          ...source,
          sourceKey,
          eventSourceKey,
          status: "PROJECTED",
          rewards: source.rewards.map((reward) => ({
            ...reward,
            sourceKey: projectedKey(reward.sourceKey),
            expectedAt: projectIso(reward.expectedAt),
            reviewedAt: null,
          })),
        };
      }),
      issues: result.issues.map((issue) => ({
        ...issue,
        sourceKey: projectedKey(issue.sourceKey),
      })),
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: options.retrievedAt,
    review: {
      status: "NEEDS_REVIEW",
      reviewedAt: null,
      note: "Schedule dates publish automatically. Extracted rewards remain marked as unreviewed.",
    },
    sources: normalized.map(({ source }) => source),
    families: normalized.map(({ family }) => family),
    events: normalized.map(({ event }) => event),
    rewardSources: normalized.flatMap(({ rewardSources }) => rewardSources),
    issues: normalized.flatMap(({ issues }) => issues),
    stats: {
      fetched: rawEvents.length,
      selected: selected.length,
      excluded: rawEvents.length - selected.length,
    },
  };
}
