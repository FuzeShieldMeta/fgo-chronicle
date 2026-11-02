import { createHash } from "node:crypto";
import { z } from "zod";
import { parseEventDataset } from "./event-dataset.mjs";
import {
  projectJpEventTiming,
  EVENT_BOUNDARY_PROJECTION_METHOD,
} from "./jp-event-projection.mjs";
import { isMutableSourceEvent } from "./jp-event-sync.mjs";

export const EVENT_TIMING_BACKFILL_LIMITS = Object.freeze({
  events: 25,
  rewards: 250,
});
const id = z.string().min(1).max(200);
const date = z.iso.datetime();
const precision = z.enum(["EXACT", "DATE_ONLY"]);
const snapshotSchema = z.object({
  readOnly: z.literal(true),
  capturedAt: date,
  events: z
    .array(
      z
        .object({
          id,
          sourceKey: id,
          status: z.string(),
          sourceRegion: z.string(),
          type: z.string(),
          startsAt: date,
          endsAt: date.nullable(),
          startsAtPrecision: precision,
          endsAtPrecision: precision.nullable(),
          sourceStartsAt: date.nullable(),
          sourceEndsAt: date.nullable(),
          rewardSources: z.array(
            z
              .object({
                id,
                sourceKey: id,
                status: z.string(),
                rewards: z.array(
                  z
                    .object({
                      id,
                      sourceKey: id,
                      expectedAt: date.nullable(),
                      dateBasis: z.string(),
                    })
                    .passthrough(),
                ),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    )
    .max(500),
});
const selectionSchema = z
  .object({
    eventIds: z.array(id).min(1).max(EVENT_TIMING_BACKFILL_LIMITS.events),
    asOf: date,
  })
  .strict();
const eventFields = [
  "startsAt",
  "endsAt",
  "startsAtPrecision",
  "endsAtPrecision",
  "projectionMethod",
  "sourceStartsAtPrecision",
  "sourceEndsAtPrecision",
  "sourceContentHash",
];
const rewardFields = ["expectedAt", "dateBasis"];
const contentFields = [
  "itemType",
  "amount",
  "nature",
  "eligibility",
  "defaultIncluded",
  "storyWarId",
  "storyReleaseAt",
];

/** @param {unknown} value */
function fingerprint(value) {
  const text = JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
  return createHash("sha256").update(text).digest("hex");
}
/** @param {Record<string, any>} row @param {string[]} fields */
function values(row, fields) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}
/** @param {Array<Record<string, any>>} rows @param {string} field */
function unique(rows, field) {
  if (new Set(rows.map((row) => row[field])).size !== rows.length)
    throw new Error(`Duplicate ${field} in timing review input.`);
}
/** @param {Record<string, any>} current @param {Record<string, any>} proposed @param {string[]} fields */
function changed(current, proposed, fields) {
  return fields.some(
    (field) => (current[field] ?? null) !== (proposed[field] ?? null),
  );
}

/**
 * Review a bounded timing-only batch from validated pipeline output. This pure
 * planner neither grants publication authority nor bypasses the import freeze.
 * @param {unknown} rawSnapshot
 * @param {Record<string, any>} pipeline
 * @param {unknown} rawSelection
 */
export function planEventTimingBackfill(rawSnapshot, pipeline, rawSelection) {
  const snapshot = snapshotSchema.parse(rawSnapshot);
  const selection = selectionSchema.parse(rawSelection);
  const preparation = pipeline.preparationStatus;
  if (
    !preparation ||
    preparation.inputCoverageComplete !== true ||
    preparation.diagnostic !== false ||
    preparation.missingPageTitles?.length !== 0
  )
    throw new Error("Complete strict pipeline preparation is required.");
  const datasets = [
    parseEventDataset(pipeline.atlas),
    parseEventDataset(pipeline.fandomPublication?.dataset),
    parseEventDataset(pipeline.masterMissions),
  ];
  unique(snapshot.events, "id");
  unique(snapshot.events, "sourceKey");
  const storedRewards = snapshot.events.flatMap((event) =>
    event.rewardSources.flatMap((source) => source.rewards),
  );
  unique(storedRewards, "id");
  unique(storedRewards, "sourceKey");
  if (new Set(selection.eventIds).size !== selection.eventIds.length)
    throw new Error("The timing review selects an event more than once.");
  const candidates = datasets.flatMap((dataset) => dataset.events);
  const sources = datasets.flatMap((dataset) => dataset.rewardSources);
  unique(candidates, "sourceKey");
  unique(sources, "sourceKey");
  unique(
    sources.flatMap((source) => source.rewards),
    "sourceKey",
  );
  const eventByKey = new Map(
    candidates.map((event) => [event.sourceKey, event]),
  );
  unique(
    pipeline.fandomPublication.masterMissionAssociations ?? [],
    "rewardSourceKey",
  );
  const associations = new Map(
    (pipeline.fandomPublication.masterMissionAssociations ?? []).map(
      (/** @type {Record<string, any>} */ row) => [
        row.rewardSourceKey,
        row.eventSourceKey,
      ],
    ),
  );
  const selected = selection.eventIds
    .map((eventId) => {
      const event = snapshot.events.find((row) => row.id === eventId);
      if (!event)
        throw new Error("A selected event is absent from the snapshot.");
      return event;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const rows = selected.map((event) => {
    const existing = /** @type {Record<string, any>} */ (event);
    const next = eventByKey.get(event.sourceKey);
    const issues = [];
    if (!next) issues.push("MISSING_SOURCE_CANDIDATE");
    if (
      event.status !== "PROJECTED" ||
      event.sourceRegion !== "JP" ||
      existing.globalBaseline ||
      existing.dateOverlay ||
      existing.reviews?.length ||
      existing.bannerTimingAnchors?.length ||
      (existing.curation?.active &&
        existing.curation.ownedFields.some((/** @type {string} */ field) =>
          ["startsAt", "endsAt", "shiftRewardDates"].includes(field),
        ))
    )
      issues.push("PROTECTED_EVENT_TIMING");
    if (next) {
      if (
        next.projectionMethod !== EVENT_BOUNDARY_PROJECTION_METHOD ||
        next.sourceStartsAtPrecision !== "EXACT" ||
        !next.sourceContentHash
      )
        issues.push("SOURCE_TIMING_NOT_ELIGIBLE");
      if (
        next.sourceStartsAt !== event.sourceStartsAt ||
        next.sourceEndsAt !== event.sourceEndsAt ||
        next.type !== event.type
      )
        issues.push("SOURCE_INTERVAL_OR_TYPE_CHANGED");
      const timing = next.sourceStartsAt
        ? projectJpEventTiming({
            type: next.type,
            sourceStartsAt: next.sourceStartsAt,
            sourceStartsAtPrecision: next.sourceStartsAtPrecision ?? null,
            sourceEndsAt: next.sourceEndsAt ?? null,
            sourceEndsAtPrecision: next.sourceEndsAtPrecision ?? null,
          })
        : null;
      if (
        !timing ||
        changed(next, timing, [
          "startsAt",
          "endsAt",
          "startsAtPrecision",
          "endsAtPrecision",
          "projectionMethod",
        ])
      )
        issues.push("CANDIDATE_PROJECTION_MISMATCH");
    }
    const prefix = event.sourceKey.replace(":projection:NA", "") + ":";
    if (
      datasets.some((dataset) =>
        dataset.issues.some(
          (issue) =>
            issue.severity === "ERROR" && issue.sourceKey.startsWith(prefix),
        ),
      )
    )
      issues.push("SOURCE_ERRORS_REQUIRE_REVIEW");
    const desiredSources = sources.filter(
      (source) =>
        (associations.get(source.sourceKey) ?? source.eventSourceKey) ===
        event.sourceKey,
    );
    const rewards = new Map(
      desiredSources.flatMap((source) =>
        source.rewards.map((reward) => [reward.sourceKey, { source, reward }]),
      ),
    );
    const rewardChanges = [];
    const heldRewards = [];
    for (const source of event.rewardSources)
      for (const reward of source.rewards) {
        const before = /** @type {Record<string, any>} */ (reward);
        const matched = rewards.get(reward.sourceKey);
        const after = matched?.reward;
        let reason = null;
        if (!after) reason = "UNMATCHED_RETAINED";
        else if (issues.length) reason = "PARENT_TIMING_HELD";
        else if (
          matched.source.type !== source.type ||
          matched.source.status !== "PROJECTED"
        )
          reason = "REWARD_SOURCE_CONTEXT_CHANGED";
        else if (
          after.dateBasis === "EVENT_END" &&
          (next?.endsAtPrecision !== "EXACT" ||
            after.expectedAt !== next.endsAt)
        )
          reason = "REWARD_DATE_PROJECTION_MISMATCH";
        else if (
          source.status !== "PROJECTED" ||
          before.globalBaseline ||
          before.dateOverlay ||
          before.reviewedAt ||
          before.reviews?.length ||
          (before.curation?.active &&
            before.curation.ownedFields.includes("expectedAt"))
        )
          reason = "PROTECTED_REWARD_DATE";
        else if (
          before.dateBasis === "ABSOLUTE" ||
          before.storyWarId ||
          !before.expectedAt ||
          !after.expectedAt ||
          !["EVENT_END", "START_RELATIVE"].includes(after.dateBasis ?? "")
        )
          reason = "INDEPENDENT_OR_UNRESOLVED_DATE";
        else if (changed(before, after, contentFields))
          reason = "REWARD_CONTENT_CHANGED";
        if (reason) {
          heldRewards.push({
            id: reward.id,
            sourceKey: reward.sourceKey,
            reason,
          });
          continue;
        }
        if (after && changed(before, after, rewardFields))
          rewardChanges.push({
            id: reward.id,
            sourceKey: reward.sourceKey,
            before: values(before, rewardFields),
            after: values(after, rewardFields),
          });
      }
    return {
      id: event.id,
      sourceKey: event.sourceKey,
      status: issues.length ? "HELD" : "REVIEWABLE",
      issues,
      frozen: !isMutableSourceEvent(existing, new Date(selection.asOf)),
      snapshotFingerprint: fingerprint(event),
      before: values(existing, eventFields),
      after: next ? values(next, eventFields) : null,
      eventChange:
        !issues.length && next ? changed(existing, next, eventFields) : false,
      rewardChanges,
      heldRewards,
    };
  });
  const rewardCount = rows.reduce(
    (count, row) => count + row.rewardChanges.length,
    0,
  );
  if (rewardCount > EVENT_TIMING_BACKFILL_LIMITS.rewards)
    throw new Error(
      "Timing review exceeds the reward change limit; select a smaller batch.",
    );
  return {
    scope: "REVIEW_ONLY_EVENT_TIMING_BACKFILL",
    publicationAllowed: false,
    snapshotCapturedAt: snapshot.capturedAt,
    asOf: selection.asOf,
    sourceFingerprint: fingerprint(pipeline),
    snapshotFingerprint: fingerprint(selected),
    reviewFingerprint: fingerprint({
      source: pipeline,
      snapshot: selected,
      selection: { ...selection, eventIds: selected.map((row) => row.id) },
      rows,
    }),
    eventChanges: rows.filter((row) => row.eventChange).length,
    rewardChanges: rewardCount,
    rows,
  };
}
