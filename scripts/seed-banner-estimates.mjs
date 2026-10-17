import { readFile } from "node:fs/promises";
import { PrismaClient } from "../generated/prisma/index.js";
import { importBannerDataset } from "../src/server/services/banner-import.js";

const db = new PrismaClient();
try {
  const dataset = JSON.parse(
    await readFile(
      new URL("../data/banner-estimates.json", import.meta.url),
      "utf8",
    ),
  );
  const report = await importBannerDataset(db, dataset);
  console.log(
    `Imported ${report.imported} banners and ${report.servants} Servants (${report.changedBanners} changed banners).`,
  );
} catch {
  console.error(
    "Banner import failed. Check the dataset and database connectivity.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
