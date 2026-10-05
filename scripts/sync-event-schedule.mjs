import { PrismaClient } from "../generated/prisma/index.js";
import { runCompleteEventSchedule } from "../src/server/services/complete-event-schedule.js";
import { safeSyncFailure } from "./lib/event-schedule-monitoring.mjs";

const db = new PrismaClient();

function parseArguments(values) {
  const options = {
    dryRun: false,
    asOf: new Date(),
    sourceFile: null,
    warSourceFile: null,
    masterMissionSourceFile: null,
    outputPath: process.env.FANDOM_COVERAGE_DATA_PATH?.trim() || null,
  };
  for (const value of values) {
    if (value === "--dry-run") {
      options.dryRun = true;
    } else if (value.startsWith("--as-of=")) {
      const date = value.slice("--as-of=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("--as-of must use YYYY-MM-DD.");
      }
      options.asOf = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(options.asOf.getTime())) {
        throw new Error("--as-of contains an invalid date.");
      }
    } else if (value.startsWith("--source-file=")) {
      options.sourceFile = value.slice("--source-file=".length);
    } else if (value.startsWith("--war-source-file=")) {
      options.warSourceFile = value.slice("--war-source-file=".length);
    } else if (value.startsWith("--master-mission-source-file=")) {
      options.masterMissionSourceFile = value.slice(
        "--master-mission-source-file=".length,
      );
    } else if (value.startsWith("--output=")) {
      options.outputPath = value.slice("--output=".length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const secret = process.env.CRON_SECRET;
  const request = new Request(
    "http://localhost/internal/event-schedule-import",
    {
      headers: { authorization: `Bearer ${secret ?? ""}` },
    },
  );
  const report = await runCompleteEventSchedule(db, options, {
    request,
    secret,
  });
  console.log(JSON.stringify(report, null, 2));
  if (
    report.globalSources.atlas.status === "failed" ||
    report.globalSources.publisher.status === "failed"
  )
    process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error("Event schedule synchronisation failed.");
  console.error(safeSyncFailure(error));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
