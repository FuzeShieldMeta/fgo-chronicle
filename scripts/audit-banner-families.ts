import { readFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "../generated/prisma/index.js";
import { z } from "zod";
import { GLOBAL_SOURCE_LIMITS } from "../src/shared/global-reconciliation-config";
import {
  assessBannerFamily,
  loadBannerFamilyEvents,
} from "../src/server/services/banner-family-association";

const bannerSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date().nullable(),
});
const datasetSchema = z.object({
  importedAt: z.string().optional(),
  banners: z.array(bannerSchema),
});
const options = {
  sourceFile: "data/banner-estimates.json",
  asOf: new Date().toISOString().slice(0, 10),
  output: null as string | null,
};
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--source-file="))
    options.sourceFile = argument.slice("--source-file=".length);
  else if (argument.startsWith("--as-of="))
    options.asOf = z.string().date().parse(argument.slice("--as-of=".length));
  else if (argument.startsWith("--output="))
    options.output = argument.slice("--output=".length);
  else throw new Error(`Unknown argument: ${argument}`);
}
const start = new Date(`${options.asOf}T00:00:00Z`);
const end = new Date(start);
end.setUTCFullYear(end.getUTCFullYear() + 2);
const endDate = end.toISOString().slice(0, 10);
const dataset = datasetSchema.parse(
  JSON.parse(await readFile(options.sourceFile, "utf8")) as unknown,
);
const rows = dataset.banners.filter(
  (banner) =>
    banner.startDate < endDate &&
    (banner.endDate ?? banner.startDate) >= options.asOf,
);
const db = new PrismaClient({ log: [] });
try {
  const report = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const events = await loadBannerFamilyEvents(tx);
      const banners = await tx.banner.findMany({
        where: {
          OR: [
            {
              sourceKey: {
                in: rows.map((row) =>
                  [
                    row.name.trim().toLowerCase(),
                    row.startDate,
                    row.endDate ?? "",
                  ].join(":"),
                ),
              },
            },
            {
              startsAt: { lt: end },
              OR: [
                { endsAt: { gte: start } },
                { endsAt: null, startsAt: { gte: start } },
              ],
            },
          ],
        },
        select: {
          sourceKey: true,
          name: true,
          startsAt: true,
          endsAt: true,
          familyId: true,
        },
        orderBy: { startsAt: "asc" },
        take: GLOBAL_SOURCE_LIMITS.maxBatchRecords + 1,
      });
      if (
        banners.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords ||
        rows.length > GLOBAL_SOURCE_LIMITS.maxBatchRecords
      )
        throw new Error("Banner audit exceeds the record limit.");
      const entries = rows.map((row) => {
        const sourceKey = [
          row.name.trim().toLowerCase(),
          row.startDate,
          row.endDate ?? "",
        ].join(":");
        const saved = banners.find((banner) => banner.sourceKey === sourceKey);
        const assessment = assessBannerFamily(
          { name: row.name, startsAt: new Date(`${row.startDate}T00:00:00Z`) },
          events,
        );
        const standalone =
          /\b(?:weekly summoning campaign|spring new master aid campaign|all servants summoning campaign)\b/iu.test(
            row.name,
          );
        const status = !saved
          ? "NOT_IMPORTED"
          : saved.familyId
            ? assessment.familyId && assessment.familyId !== saved.familyId
              ? "LINK_CONFLICT"
              : "LINKED"
            : assessment.familyId
              ? "LINKABLE"
              : assessment.candidateFamilyIds.length > 1
                ? "AMBIGUOUS"
                : standalone
                  ? "STANDALONE"
                  : "UNRESOLVED";
        return {
          ...row,
          status,
          familyId: saved?.familyId ?? null,
          currentFamilyEvents: events
            .filter((event) => event.familyId === saved?.familyId)
            .map((event) => ({ sourceKey: event.sourceKey, name: event.name })),
          proposedFamilyId: assessment.familyId,
          candidates: events
            .filter((event) =>
              assessment.candidateFamilyIds.includes(event.familyId!),
            )
            .map((event) => ({ sourceKey: event.sourceKey, name: event.name })),
        };
      });
      return {
        generatedAt: new Date().toISOString(),
        sourceFile: options.sourceFile,
        spreadsheetFetchedAt: dataset.importedAt,
        from: options.asOf,
        untilExclusive: endDate,
        total: entries.length,
        counts: entries.reduce<Record<string, number>>((counts, entry) => {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return counts;
        }, {}),
        entries,
        obsoleteImports: banners.filter(
          (banner) =>
            !dataset.banners.some(
              (row) =>
                [
                  row.name.trim().toLowerCase(),
                  row.startDate,
                  row.endDate ?? "",
                ].join(":") === banner.sourceKey,
            ),
        ),
      };
    },
    { timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs },
  );
  if (options.output)
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    "Banner family audit failed.",
    error instanceof z.ZodError
      ? "Invalid input dataset."
      : "Check database connectivity and record limits.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
