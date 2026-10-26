import {
  inventoryJpBannerAnnouncements,
  type JpBannerInventoryOptions,
} from "../src/server/services/jp-banner-inventory";

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(
      "Usage: npm run data:review-jp-banners -- [--pages=1..50 --start-page=1..5000 | --article=OFFICIAL_URL ...] [--inspect=0..20] [--follow-links=0..20] [--resolve-servants] [--project-na]\nRead-only JP announcement inspection. Defaults to two archive pages and no article requests. --article selects official JP articles directly (up to 20, inspected by default) instead of reading an index. --follow-links adds bounded official linked-notice requests; inspect plus follow-links must not exceed 20. Links do not establish family identity. --resolve-servants matches catalogue identities and explicit pickup statements. --project-na previews reset-relative NA times using one estimated notice anchor and a two-calendar-year shift, not confirmed NA availability. No image downloads or publication.",
    );
  } else {
    const options: JpBannerInventoryOptions = {};
    const seen = new Set<string>();
    for (const argument of process.argv.slice(2)) {
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
    const report = await inventoryJpBannerAnnouncements(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "partial_failure") process.exitCode = 1;
  }
} catch {
  console.error(
    "Could not inspect JP announcements. Use --help for archive/direct URL modes and request limits. No data was published.",
  );
  process.exitCode = 1;
}
