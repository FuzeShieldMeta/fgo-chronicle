import { createHash } from "node:crypto";

import { writeDatasetAtomically } from "./lib/event-schedule-pipeline.mjs";
import { buildFandomCoverage } from "./lib/fandom-coverage.mjs";
import { buildProjectedMasterMissionDataset } from "./lib/jp-master-mission-sync.mjs";
import { buildProjectedEventDataset } from "./lib/jp-event-sync.mjs";
import { preferAtlasMasterMissions } from "./lib/master-mission-precedence.mjs";
import {
  loadJpEventSource,
  loadJpMasterMissionSource,
  loadJpWarSource,
  parseAndValidateAtlasMasterMissionSource,
  parseAndValidateAtlasSource,
  parseAndValidateAtlasWarSource,
  parseIntegerSetting,
} from "./lib/jp-event-source.mjs";

function parseArguments(values) {
  const options = {
    asOf: new Date(),
    atlasSourceFile: null,
    atlasWarSourceFile: null,
    atlasMasterMissionSourceFile: null,
    dryRun: false,
    quiet: false,
    outputPath: process.env.FANDOM_COVERAGE_DATA_PATH?.trim() || null,
  };
  for (const value of values) {
    if (value === "--dry-run") {
      options.dryRun = true;
    } else if (value === "--quiet") {
      options.quiet = true;
    } else if (value.startsWith("--as-of=")) {
      const date = value.slice("--as-of=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("--as-of must use YYYY-MM-DD.");
      }
      options.asOf = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(options.asOf.getTime())) {
        throw new Error("--as-of contains an invalid date.");
      }
    } else if (value.startsWith("--atlas-source-file=")) {
      options.atlasSourceFile = value.slice("--atlas-source-file=".length);
    } else if (value.startsWith("--atlas-war-source-file=")) {
      options.atlasWarSourceFile = value.slice(
        "--atlas-war-source-file=".length,
      );
    } else if (value.startsWith("--atlas-master-mission-source-file=")) {
      options.atlasMasterMissionSourceFile = value.slice(
        "--atlas-master-mission-source-file=".length,
      );
    } else if (value.startsWith("--output=")) {
      options.outputPath = value.slice("--output=".length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!options.dryRun && !options.outputPath) {
    throw new Error(
      "FANDOM_COVERAGE_DATA_PATH or --output is required unless --dry-run is used.",
    );
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const minimumRecords = parseIntegerSetting(
    process.env.JP_EVENT_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_EVENT_SYNC_MIN_EXPORT_RECORDS", defaultValue: 1_000 },
  );
  const [atlasBody, atlasWarBody, atlasMasterMissionBody] = await Promise.all([
    loadJpEventSource({ sourceFile: options.atlasSourceFile }),
    loadJpWarSource({ warSourceFile: options.atlasWarSourceFile }),
    loadJpMasterMissionSource({
      masterMissionSourceFile: options.atlasMasterMissionSourceFile,
    }),
  ]);
  const atlasEvents = parseAndValidateAtlasSource(atlasBody, minimumRecords);
  const minimumWarRecords = parseIntegerSetting(
    process.env.JP_WAR_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_WAR_SYNC_MIN_EXPORT_RECORDS", defaultValue: 200 },
  );
  const atlasWars = parseAndValidateAtlasWarSource(
    atlasWarBody,
    minimumWarRecords,
  );
  const minimumMasterMissionRecords = parseIntegerSetting(
    process.env.JP_MASTER_MISSION_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_MASTER_MISSION_SYNC_MIN_EXPORT_RECORDS", defaultValue: 50 },
  );
  const atlasMasterMissions = parseAndValidateAtlasMasterMissionSource(
    atlasMasterMissionBody,
    minimumMasterMissionRecords,
  );
  const retrievedAt = new Date().toISOString();
  const atlasDataset = buildProjectedEventDataset(atlasEvents, {
    asOf: options.asOf,
    retrievedAt,
    contentHash: `sha256:${createHash("sha256").update(atlasBody).digest("hex")}`,
    warContentHash: `sha256:${createHash("sha256").update(atlasWarBody).digest("hex")}`,
    rawWars: atlasWars,
  });
  const masterMissionDataset = buildProjectedMasterMissionDataset(
    atlasMasterMissions,
    {
      asOf: options.asOf,
      retrievedAt,
      contentHash: `sha256:${createHash("sha256").update(atlasMasterMissionBody).digest("hex")}`,
    },
  );
  const result = await buildFandomCoverage(atlasEvents, {
    asOf: options.asOf,
    rawWars: atlasWars,
    warContentHash: `sha256:${createHash("sha256").update(atlasWarBody).digest("hex")}`,
  });
  const precedence = preferAtlasMasterMissions(
    result.dataset,
    masterMissionDataset,
    atlasEvents,
  );
  const availableEventKeys = new Set([
    ...atlasDataset.events.map(({ sourceKey }) => sourceKey),
    ...precedence.dataset.events.map(({ sourceKey }) => sourceKey),
  ]);
  const missingAssociationTargets = [
    ...new Set(
      precedence.masterMissionAssociations
        .map(({ eventSourceKey }) => eventSourceKey)
        .filter((sourceKey) => !availableEventKeys.has(sourceKey)),
    ),
  ];

  if (!options.dryRun) {
    await writeDatasetAtomically(options.outputPath, precedence.dataset);
  }

  if (!options.quiet) {
    console.log(
      JSON.stringify(
        {
          atlasEventRewards: atlasDataset.stats,
          masterMissions: {
            ...masterMissionDataset.stats,
            ...precedence.report,
            missingAssociationTargets,
          },
          atlasFetched: result.report.atlasFetched,
          atlasSelected: result.report.atlasSelected,
          fandomListEntries: result.report.fandomListEntries,
          matchedAtlas: result.report.matchedAtlas,
          matchMethods: result.report.matchMethods,
          reviewCandidates: result.report.reviewCandidates,
          embeddedPermanentQuestReleases:
            result.report.embeddedPermanentQuestReleases,
          matchedSupplementRewards: result.report.matchedSupplementRewards,
          heldMatchedRewardSources: result.report.heldMatchedRewardSources,
          explicitExclusionCount: result.report.explicitExclusions.length,
          unresolved: result.report.unresolved,
          missingUpcoming: result.report.upcoming.filter(
            ({ status }) => status === "MISSING_SOURCE_EVENT",
          ),
          resolvedAliases: result.report.resolvedAliases,
          detectedPreReleaseCampaigns: result.report.upcomingCompanions
            .filter(({ companions }) => companions.length > 0)
            .map(({ name, companions }) => ({ name, companions })),
          revisionCount: result.report.revisions.length,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error("Event coverage audit failed.");
  console.error(error);
  process.exitCode = 1;
});
