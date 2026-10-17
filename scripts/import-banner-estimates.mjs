import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadBannerSpreadsheet } from "../src/server/services/banner-spreadsheet.js";

try {
  const dataset = await downloadBannerSpreadsheet();
  const outputDirectory = path.resolve("data");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "banner-estimates.json"),
    `${JSON.stringify(dataset, null, 2)}\n`,
  );
  console.log(
    `Imported ${dataset.count} unique banners into data/banner-estimates.json`,
  );
} catch {
  console.error(
    "Spreadsheet download failed. Check its configuration and source availability.",
  );
  process.exitCode = 1;
}
