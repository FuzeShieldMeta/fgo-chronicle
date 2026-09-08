import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseEventDataset } from "./lib/event-dataset.mjs";
import { writeDatasetAtomically } from "./lib/event-schedule-pipeline.mjs";

/** @param {string[]} values */
function parseArguments(values) {
  const options =
    /** @type {{inputPath: string | null, outputPath: string | null, eventSourceKeys: string[], approve: boolean}} */ ({
      inputPath: null,
      outputPath: null,
      eventSourceKeys: [],
      approve: false,
    });
  for (const value of values) {
    if (value === "--approve") {
      options.approve = true;
    } else if (value.startsWith("--input=")) {
      options.inputPath = value.slice("--input=".length);
    } else if (value.startsWith("--output=")) {
      options.outputPath = value.slice("--output=".length);
    } else if (value.startsWith("--event-source-key=")) {
      options.eventSourceKeys.push(value.slice("--event-source-key=".length));
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!options.inputPath || !options.outputPath) {
    throw new Error("--input and --output are required.");
  }
  if (options.eventSourceKeys.length === 0) {
    throw new Error("At least one --event-source-key is required.");
  }
  return {
    ...options,
    inputPath: options.inputPath,
    outputPath: options.outputPath,
  };
}

/**
 * Create a small review dataset without changing individual reward review
 * state. Dataset approval confirms only that the selected records may import.
 * @param {Record<string, any>} dataset
 * @param {string[]} requestedKeys
 * @param {{approve: boolean, now?: () => Date}} options
 */
export function selectEventReviewDataset(dataset, requestedKeys, options) {
  const parsed = parseEventDataset(dataset);
  const preparedAt = (options.now ?? (() => new Date()))().toISOString();
  const requested = new Set(requestedKeys);
  const events = parsed.events.filter(({ sourceKey }) =>
    requested.has(sourceKey),
  );
  const found = new Set(events.map(({ sourceKey }) => sourceKey));
  const missing = requestedKeys.filter((sourceKey) => !found.has(sourceKey));
  if (missing.length > 0) {
    throw new Error(`Event source keys were not found: ${missing.join(", ")}.`);
  }

  const familyKeys = new Set(
    events.flatMap(({ familySourceKey }) =>
      familySourceKey ? [familySourceKey] : [],
    ),
  );
  const rewardSources = parsed.rewardSources.filter(({ eventSourceKey }) =>
    eventSourceKey ? requested.has(eventSourceKey) : false,
  );
  const evidenceKeys = new Set([
    ...events.map(({ evidenceSourceKey }) => evidenceSourceKey),
    ...rewardSources.map(({ evidenceSourceKey }) => evidenceSourceKey),
  ]);
  const issuePrefixes = [...evidenceKeys, ...requested];
  const selected = {
    ...parsed,
    generatedAt: preparedAt,
    review: options.approve
      ? {
          status: "APPROVED",
          reviewedAt: preparedAt,
          note: `Approved selected events: ${requestedKeys.join(", ")}`,
        }
      : {
          status: "NEEDS_REVIEW",
          reviewedAt: null,
          note: `Selected events require review: ${requestedKeys.join(", ")}`,
        },
    sources: parsed.sources.filter(({ sourceKey }) =>
      evidenceKeys.has(sourceKey),
    ),
    families: parsed.families.filter(({ sourceKey }) =>
      familyKeys.has(sourceKey),
    ),
    events,
    rewardSources,
    issues: parsed.issues.filter(({ sourceKey }) =>
      issuePrefixes.some((prefix) => sourceKey.startsWith(prefix)),
    ),
  };
  return parseEventDataset(selected);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const dataset = JSON.parse(
    await readFile(path.resolve(options.inputPath), "utf8"),
  );
  const selected = selectEventReviewDataset(dataset, options.eventSourceKeys, {
    approve: options.approve,
  });
  await writeDatasetAtomically(options.outputPath, selected);
  console.log(
    `Prepared ${selected.events.length} event and ${selected.rewardSources.length} reward sources at ${options.outputPath}.`,
  );
  console.log(`Review status: ${selected.review.status}.`);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  main().catch((error) => {
    console.error("Event review preparation failed.");
    console.error(error);
    process.exitCode = 1;
  });
}
