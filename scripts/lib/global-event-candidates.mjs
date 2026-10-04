import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { normalizeAtlasEvent } from "./atlas-event-adapter.mjs";
import { classifyAtlasScheduleEvent } from "./jp-event-sync.mjs";
import {
  fetchTextWithRetry,
  parseAndValidateAtlasSource,
} from "./jp-event-source.mjs";

export const GLOBAL_EVENT_EXPORTS = {
  JP: "https://api.atlasacademy.io/export/JP/nice_event_lang_en.json",
  NA: "https://api.atlasacademy.io/export/NA/nice_event.json",
};

/** @param {string} value */
const hash = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const rangeSchema = z
  .object({ from: z.date(), through: z.date() })
  .refine(({ from, through }) => through >= from, {
    message: "The report end must not precede its start.",
  });

/**
 * @param {"JP" | "NA"} region
 * @param {{sourceFile?: string | null, minimumRecords?: number}} options
 * @param {{body?: string, now?: () => Date, readFileFn?: typeof readFile, fetchFn?: typeof fetch}} [dependencies]
 */
export async function loadGlobalEventExport(
  region,
  options = {},
  dependencies = {},
) {
  if (!(region in GLOBAL_EVENT_EXPORTS))
    throw new Error("Unsupported Atlas region.");
  const minimum = options.minimumRecords ?? (region === "JP" ? 1000 : 700);
  if (!Number.isSafeInteger(minimum) || minimum < 1)
    throw new Error("The export minimum must be a positive integer.");
  const body =
    dependencies.body ??
    (options.sourceFile
      ? await (dependencies.readFileFn ?? readFile)(options.sourceFile, "utf8")
      : await fetchTextWithRetry(GLOBAL_EVENT_EXPORTS[region], {
          fetchFn: dependencies.fetchFn,
        }));
  let events;
  const sourceIssues = [];
  try {
    events = parseAndValidateAtlasSource(body, minimum);
  } catch (error) {
    // Invalid periods remain visible as issues, never confirmation candidates.
    // All other schema, duplicate-ID and export-size failures remain fatal.
    if (
      !(error instanceof z.ZodError) ||
      !error.issues.length ||
      error.issues.some(
        (issue) =>
          issue.code !== "custom" ||
          issue.path.length !== 2 ||
          typeof issue.path[0] !== "number" ||
          issue.path[1] !== "endedAt" ||
          issue.message !== "An Atlas event cannot end before it starts.",
      )
    )
      throw error;
    const raw = /** @type {Array<Record<string, any>>} */ (JSON.parse(body));
    uniqueIndex(raw);
    const invalid = new Set(
      error.issues.map((issue) => /** @type {number} */ (issue.path[0])),
    );
    events = parseAndValidateAtlasSource(
      JSON.stringify(raw.filter((_, index) => !invalid.has(index))),
      minimum,
    );
    for (const index of invalid) {
      const record = raw[index];
      if (!record) throw error;
      sourceIssues.push({
        sourceRecordId: record.id,
        code: "INVALID_DATE_RANGE",
        name: record.name,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        publicationAllowed: false,
      });
    }
  }
  const retrievedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  return {
    region,
    url: GLOBAL_EVENT_EXPORTS[region],
    inputKind: options.sourceFile ? "FILE" : "EXPORT",
    retrievedAt,
    contentHash: hash(body),
    events,
    sourceIssues,
  };
}

/** @param {Array<Record<string, any>>} events */
function uniqueIndex(events) {
  const index = new Map();
  for (const event of events) {
    if (index.has(event.id))
      throw new Error(`Duplicate Atlas event ID: ${event.id}.`);
    index.set(event.id, event);
  }
  return index;
}

/** @param {Record<string, any>} event */
function associations(event) {
  const values = event.warIds ?? [];
  return {
    ids: [...new Set(values)].sort((a, b) => a - b),
    repeated: values.length !== new Set(values).size,
  };
}

/**
 * Identity candidates require an event ID, event type and non-empty war association.
 * This report does not authorise publication or infer links from translated names.
 * @param {Awaited<ReturnType<typeof loadGlobalEventExport>>} jp
 * @param {Awaited<ReturnType<typeof loadGlobalEventExport>>} na
 * @param {Array<Record<string, any>>} existingEvents
 * @param {{from: Date, through: Date, databaseInspected?: boolean}} options
 */
export function buildGlobalEventReport(jp, na, existingEvents, options) {
  const range = rangeSchema.parse(options);
  if (jp.region !== "JP" || na.region !== "NA")
    throw new Error("Expected JP and NA source exports.");
  const jpById = uniqueIndex(jp.events);
  uniqueIndex(na.events);
  const existingByKey = new Map();
  for (const event of existingEvents) {
    const previous = existingByKey.get(event.sourceKey) ?? [];
    previous.push(event);
    existingByKey.set(event.sourceKey, previous);
  }
  const candidates = na.events
    .filter(
      (event) =>
        event.startedAt * 1000 <= range.through.getTime() &&
        event.endedAt * 1000 >= range.from.getTime(),
    )
    .sort((a, b) => a.id - b.id)
    .map((event) => {
      const jpEvent = jpById.get(event.id);
      const linked = associations(event);
      const origin = jpEvent ? associations(jpEvent) : null;
      const projectedKey = `atlas:JP:event:${event.id}:projection:NA`;
      const targets = existingByKey.get(projectedKey) ?? [];
      const reasons = [];
      const eventType = classifyAtlasScheduleEvent(event);
      if (!eventType) reasons.push("UNSUPPORTED_EVENT_TYPE");
      if (!jpEvent) reasons.push("NO_JP_IDENTITY");
      else {
        if (jpEvent.type !== event.type) reasons.push("EVENT_TYPE_CONFLICT");
        if (!origin?.ids.length || !linked.ids.length)
          reasons.push("MISSING_WAR_ASSOCIATION");
        else if (JSON.stringify(origin.ids) !== JSON.stringify(linked.ids))
          reasons.push("WAR_ASSOCIATION_CONFLICT");
      }
      if (linked.repeated || origin?.repeated)
        reasons.push("DUPLICATE_WAR_ASSOCIATION");
      if (options.databaseInspected) {
        if (!targets.length) reasons.push("NO_EXISTING_EVENT");
        if (targets.length > 1) reasons.push("AMBIGUOUS_EXISTING_EVENT");
        if (targets.length === 1 && targets[0].sourceRegion !== "JP")
          reasons.push("EXISTING_ORIGIN_CONFLICT");
      }
      const normalized = normalizeAtlasEvent(event, {
        region: "NA",
        retrievedAt: na.retrievedAt,
        contentHash: na.contentHash,
        family: {
          sourceKey: `atlas:NA:event:${event.id}:family`,
          name: event.name,
        },
      });
      const totals = /** @type {Record<string, number>} */ ({});
      for (const source of normalized.rewardSources) {
        for (const reward of source.rewards)
          totals[reward.itemType] =
            (totals[reward.itemType] ?? 0) + reward.amount;
      }
      const sourceRecord = {
        id: event.id,
        type: event.type,
        name: event.name,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        warIds: linked.ids,
      };
      return {
        sourceRecordId: event.id,
        identity: reasons.some(
          (reason) =>
            ![
              "NO_EXISTING_EVENT",
              "AMBIGUOUS_EXISTING_EVENT",
              "EXISTING_ORIGIN_CONFLICT",
            ].includes(reason),
        )
          ? "UNRESOLVED"
          : "ASSOCIATED",
        reasons,
        targetEventId:
          !reasons.length && targets.length === 1 ? targets[0].id : null,
        projectedSourceKey: projectedKey,
        jpName: jpEvent?.name ?? null,
        globalName: event.name,
        eventType,
        startsAt: new Date(event.startedAt * 1000).toISOString(),
        endsAt: new Date(event.endedAt * 1000).toISOString(),
        startsAtPrecision: "EXACT",
        endsAtPrecision: "EXACT",
        warIds: linked.ids,
        evidence: {
          sourceKind: "GLOBAL_GAME_DATA",
          inputKind: na.inputKind,
          sourceRegion: "NA",
          sourceRecordId: String(event.id),
          url: normalized.source.url,
          retrievedAt: na.retrievedAt,
          contentHash: hash(JSON.stringify(sourceRecord)),
        },
        jpEvidence: jpEvent
          ? {
              url: `https://api.atlasacademy.io/nice/JP/event/${jpEvent.id}`,
              exportHash: jp.contentHash,
            }
          : null,
        activeCorrection:
          targets.length === 1 && targets[0].curation?.active
            ? {
                revision: targets[0].curation.revision,
                fieldsRequireConflictReview: true,
              }
            : null,
        embeddedRewardTotals: totals,
        questRewardsInspected: false,
        coverageIssues: normalized.issues,
        publicationAllowed: false,
      };
    });
  /** @param {Awaited<ReturnType<typeof loadGlobalEventExport>>} value */
  const sourceMetadata = ({ events, ...source }) => ({
    ...source,
    recordCount: events.length + source.sourceIssues.length,
    candidateRecordCount: events.length,
  });
  return {
    schemaVersion: 1,
    dryRun: true,
    databaseInspected: Boolean(options.databaseInspected),
    from: range.from.toISOString(),
    through: range.through.toISOString(),
    sources: [sourceMetadata(jp), sourceMetadata(na)],
    summary: {
      candidates: candidates.length,
      associated: candidates.filter((value) => value.identity === "ASSOCIATED")
        .length,
      resolvedTargets: candidates.filter(
        (value) => value.targetEventId !== null,
      ).length,
      unresolved: candidates.filter((value) => value.reasons.length > 0).length,
      sourceIssues:
        (jp.sourceIssues?.length ?? 0) + (na.sourceIssues?.length ?? 0),
    },
    candidates,
  };
}

/**
 * Read-only by contract. This loader does not query player accounts or planner state.
 * @param {{event: {findMany: (args: import("../../generated/prisma/index.js").Prisma.EventFindManyArgs) => Promise<Array<Record<string, any>>>}} | null} database
 * @param {{from: Date, through: Date, jpFile?: string | null, naFile?: string | null}} options
 * @param {{loadSource?: typeof loadGlobalEventExport}} [dependencies]
 */
export async function reportGlobalEvents(database, options, dependencies = {}) {
  rangeSchema.parse(options);
  const load = dependencies.loadSource ?? loadGlobalEventExport;
  const [jp, na, events] = await Promise.all([
    load("JP", { sourceFile: options.jpFile }),
    load("NA", { sourceFile: options.naFile }),
    database
      ? database.event.findMany({
          relationLoadStrategy: "join",
          where: { sourceKey: { startsWith: "atlas:JP:event:" } },
          select: {
            id: true,
            sourceKey: true,
            sourceRegion: true,
            curation: { select: { active: true, revision: true } },
          },
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
  ]);
  return buildGlobalEventReport(jp, na, events, {
    ...options,
    databaseInspected: database !== null,
  });
}
