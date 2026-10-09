import {
  primaryImportFailure,
  reconciliationLimitDetails,
} from "./reward-reconciliation.mjs";

const MAX_COUNT = 2_147_483_647;

/** @param {Array<{severity: string}>} issues */
export function countImportIssues(issues) {
  return {
    warnings: issues.filter(
      (issue) => issue.severity === "WARNING" || issue.severity === "ERROR",
    ).length,
    informationalIssues: issues.filter((issue) => issue.severity === "INFO")
      .length,
  };
}

/** @param {unknown} value */
function count(value) {
  if (value === undefined) return 0;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_COUNT
  ) {
    throw new RangeError("Invalid synchronisation count.");
  }
  return Number(value);
}

/** @param {unknown} value @param {string[]} fields */
function counts(value, fields) {
  const record = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    fields.map((field) => [
      field,
      count(/** @type {Record<string, unknown>} */ (record)[field]),
    ]),
  );
}

/** @param {unknown} value */
function length(value) {
  return Array.isArray(value) ? value.length : 0;
}

/** @param {unknown} value */
function flag(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new RangeError("Invalid synchronisation flag.");
  return value;
}

/** Only named counters and flags can leave the pipeline. @param {Record<string, any>} report */
export function summariseEventSchedule(report) {
  const atlas = counts(report.atlas, [
    "fetched",
    "selected",
    "inserted",
    "updated",
    "rewardDefinitions",
    "omittedRewards",
    "warnings",
    "informationalIssues",
    "frozenDifferences",
    "protectedDifferences",
    "missingSourceRecords",
    "inferredWarAssociations",
    "unresolvedPlayableWarAssociations",
    "ambiguousPlayableWarAssociations",
    "unknownEventGiftLocations",
    "unknownWarGiftLocations",
    "missingReferencedWars",
  ]);
  const masterMissions = counts(report.masterMissions, [
    "fetchedSets",
    "selectedLimitedMissions",
    "selectedPermanentMissions",
    "inserted",
    "updated",
    "associationUpdates",
    "rewardDefinitions",
    "omittedWeeklyMissions",
    "omittedUnsupportedMissions",
    "warnings",
    "informationalIssues",
    "missingAssociationTargets",
  ]);
  const coverage = report.fandom ?? {};
  const publication = counts(coverage.publication, [
    "selected",
    "inserted",
    "updated",
    "rewardDefinitions",
    "warnings",
    "informationalIssues",
    "heldEvents",
    "frozenDifferences",
    "protectedDifferences",
    "missingSourceRecords",
    "missingExternalEvents",
    "supersededEvents",
    "rewardChanges",
  ]);
  const publicationLimits = {
    rewardChangeBreakdown: counts(coverage.publication?.rewardChangeBreakdown, [
      "dateBasisOnly",
      "rewardUpdates",
      "newRewards",
      "sourceUpdates",
      "removedRecords",
    ]),
    maxRewardChanges: count(coverage.publication?.rewardChangeLimit),
    rewardChangeLimitExceeded: flag(
      coverage.publication?.rewardChangeLimitExceeded,
    ),
  };
  const fandom = {
    ...counts(coverage, [
      "atlasFetched",
      "atlasSelected",
      "fandomListEntries",
      "matchedAtlas",
      "reviewCandidates",
    ]),
    heldMatchedRewardSources: length(coverage.heldMatchedRewardSources),
    explicitExclusions: length(coverage.explicitExclusions),
    unresolved: length(coverage.unresolved),
    missingUpcoming: Array.isArray(coverage.upcoming)
      ? coverage.upcoming.filter(
          (/** @type {{status?: string} | null} */ entry) =>
            entry?.status === "MISSING_SOURCE_EVENT",
        ).length
      : 0,
    publication: { ...publication, ...publicationLimits },
  };
  const warnings = {
    atlas: atlas.warnings ?? 0,
    masterMissions: masterMissions.warnings ?? 0,
    fandom: publication.warnings ?? 0,
    unresolvedFandom: fandom.unresolved,
    missingUpcoming: fandom.missingUpcoming,
    unresolvedPlayableWars: atlas.unresolvedPlayableWarAssociations ?? 0,
  };
  // Coverage reports the same Atlas export. Count it once.
  const totals = {
    fetchedCount: count(
      (atlas.fetched ?? 0) +
        (masterMissions.fetchedSets ?? 0) +
        count(coverage.fandomListEntries),
    ),
    selectedCount: count(
      (atlas.selected ?? 0) +
        (masterMissions.selectedLimitedMissions ?? 0) +
        (masterMissions.selectedPermanentMissions ?? 0) +
        (publication.selected ?? 0),
    ),
    insertedCount: count(
      (atlas.inserted ?? 0) +
        (masterMissions.inserted ?? 0) +
        (publication.inserted ?? 0),
    ),
    // Mission updates already include association updates. Do not count them twice.
    updatedCount: count(
      (atlas.updated ?? 0) +
        (masterMissions.updated ?? 0) +
        (publication.updated ?? 0) +
        (publication.supersededEvents ?? 0),
    ),
    frozenDifferenceCount: count(
      (atlas.frozenDifferences ?? 0) + (publication.frozenDifferences ?? 0),
    ),
    rewardCount: count(
      (atlas.rewardDefinitions ?? 0) +
        (masterMissions.rewardDefinitions ?? 0) +
        (publication.rewardDefinitions ?? 0),
    ),
    omittedRewardCount: count(
      (atlas.omittedRewards ?? 0) +
        (masterMissions.omittedWeeklyMissions ?? 0) +
        (masterMissions.omittedUnsupportedMissions ?? 0) +
        fandom.heldMatchedRewardSources,
    ),
    warningCount: count(
      warnings.atlas +
        warnings.masterMissions +
        warnings.fandom +
        warnings.unresolvedFandom +
        warnings.missingUpcoming,
    ),
  };
  const informational = {
    atlas: atlas.informationalIssues ?? 0,
    masterMissions: masterMissions.informationalIssues ?? 0,
    fandom: publication.informationalIssues ?? 0,
    total: count(
      (atlas.informationalIssues ?? 0) +
        (masterMissions.informationalIssues ?? 0) +
        (publication.informationalIssues ?? 0),
    ),
  };
  return { atlas, masterMissions, fandom, totals, warnings, informational };
}

/** Raw error messages can contain credentials, query parameters, or source text. @param {unknown} error */
export function safeSyncFailure(error) {
  error = primaryImportFailure(error);
  const limit = reconciliationLimitDetails(error);
  if (limit) return limit.message;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof code === "string" && /^P\d{4}$/.test(code)) {
    return `Database operation failed (${code}).`;
  }
  if (error instanceof RangeError) return "Synchronisation validation failed.";
  if (error instanceof SyntaxError) return "Source data could not be parsed.";
  if (error instanceof Error && error.name === "AbortError")
    return "Source request timed out or was cancelled.";
  return "Event schedule synchronisation failed. Inspect the run stage and source availability.";
}
