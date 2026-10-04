import { reportGlobalEvents } from "./lib/global-event-candidates.mjs";

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const through = new Date(today);
through.setUTCDate(through.getUTCDate() + 35);
through.setUTCHours(23, 59, 59, 999);
const options = { from: today, through, jpFile: null, naFile: null };
let database = null;

try {
  let includeDatabase = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--include-database") includeDatabase = true;
    else if (argument === "--jp-file=" || argument === "--na-file=")
      throw new Error("A source file path is required.");
    else if (argument.startsWith("--jp-file="))
      options.jpFile = argument.slice(10);
    else if (argument.startsWith("--na-file="))
      options.naFile = argument.slice(10);
    else if (
      argument.startsWith("--from=") ||
      argument.startsWith("--through=")
    ) {
      const [key, date] = argument.slice(2).split("=");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? ""))
        throw new Error("Dates must use YYYY-MM-DD.");
      const parsed = new Date(
        `${date}T${key === "from" ? "00:00:00.000" : "23:59:59.999"}Z`,
      );
      if (
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      )
        throw new Error("Invalid report date.");
      options[key] = parsed;
    } else throw new Error("Unknown report argument.");
  }
  if (includeDatabase) {
    const { PrismaClient } = await import("../generated/prisma/index.js");
    database = new PrismaClient({ log: [] });
  }
  const report = await reportGlobalEvents(database, options);
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(
    "Could not generate the Global event report. Check the source files, report dates and database configuration.",
  );
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
