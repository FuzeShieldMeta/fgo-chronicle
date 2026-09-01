import { PrismaClient } from "../generated/prisma/index.js";
import { runJpEventSync } from "./lib/jp-event-sync-runner.mjs";

const db = new PrismaClient();

function parseArguments(values) {
  const options = { dryRun: false, asOf: new Date(), sourceFile: null };
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
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runJpEventSync(db, options);
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} catch (error) {
  console.error("JP event synchronisation failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
