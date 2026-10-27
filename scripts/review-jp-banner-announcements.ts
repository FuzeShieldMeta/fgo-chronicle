import {
  inventoryJpBannerAnnouncements,
  type JpBannerInventoryOptions,
} from "../src/server/services/jp-banner-inventory";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { bannerDatasetSchema } from "../src/server/services/banner-dataset";
import {
  compareJpBannerEvidence,
  JP_BANNER_COMPARISON_LIMITS,
} from "../src/server/services/jp-banner-comparison";

async function comparisonBaseline(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Baseline must be a file.");
    const buffer = Buffer.alloc(
      JP_BANNER_COMPARISON_LIMITS.maxBaselineBytes + 1,
    );
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > JP_BANNER_COMPARISON_LIMITS.maxBaselineBytes)
      throw new Error("Baseline size limit exceeded.");
    return bannerDatasetSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        ),
      ) as unknown,
    );
  } finally {
    await handle.close();
  }
}

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(
      "Usage: npm run data:review-jp-banners -- [--pages=1..50 --start-page=1..5000 | --article=OFFICIAL_URL ...] [--inspect=0..20] [--follow-links=0..20] [--resolve-servants] [--project-na] [--compare=LOCAL_DATASET.json]\nRead-only JP announcement inspection. Defaults to two archive pages and no article requests. --article selects official JP articles directly (up to 20, inspected by default) instead of reading an index. --follow-links adds bounded official linked-notice requests; inspect plus follow-links must not exceed 20. Links do not establish family identity. --resolve-servants matches catalogue identities and explicit pickup statements. --project-na previews reset-relative NA times using one estimated notice anchor and a two-calendar-year shift, not confirmed NA availability. --compare requires both flags and compares partial evidence with a bounded local banner dataset; servant overlap suggests possible matches, never confirmed identity. Date-only baselines have no inferred clock or instant difference. No image downloads or publication.",
    );
  } else {
    const options: JpBannerInventoryOptions = {};
    let baselineFile: string | null = null;
    const seen = new Set<string>();
    for (const argument of process.argv.slice(2)) {
      if (argument.startsWith("--compare=")) {
        if (baselineFile !== null || !argument.slice("--compare=".length))
          throw new Error("Invalid comparison file.");
        baselineFile = argument.slice("--compare=".length);
        continue;
      }
      if (argument.startsWith("--article=")) {
        options.articleUrls ??= [];
        options.articleUrls.push(argument.slice("--article=".length));
        continue;
      }
      if (argument === "--resolve-servants" || argument === "--project-na") {
        if (seen.has(argument))
          throw new Error("Duplicate servant resolution argument.");
        seen.add(argument);
        if (argument === "--resolve-servants") options.resolveServants = true;
        else options.projectNa = true;
        continue;
      }
      const match =
        /^--(pages|start-page|inspect|follow-links)=(0|[1-9]\d*)$/.exec(
          argument,
        );
      if (!match || seen.has(match[1]!))
        throw new Error("Invalid JP inventory arguments.");
      seen.add(match[1]!);
      options[
        match[1] === "pages"
          ? "pages"
          : match[1] === "inspect"
            ? "inspect"
            : match[1] === "follow-links"
              ? "followLinks"
              : "startPage"
      ] = Number(match[2]);
    }
    if (baselineFile && (!options.resolveServants || !options.projectNa))
      throw new Error("Comparison requires identity and projection evidence.");
    const baseline = baselineFile
      ? await comparisonBaseline(baselineFile)
      : null;
    const report = await inventoryJpBannerAnnouncements(options);
    console.log(
      JSON.stringify(
        baseline
          ? { ...report, comparison: compareJpBannerEvidence(report, baseline) }
          : report,
        null,
        2,
      ),
    );
    if (report.status === "partial_failure") process.exitCode = 1;
  }
} catch {
  console.error(
    "Could not inspect JP announcements. Use --help for archive/direct URL modes and request limits. No data was published.",
  );
  process.exitCode = 1;
}
