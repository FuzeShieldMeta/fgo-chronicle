import { inventoryJpBannerAnnouncements } from "../src/server/services/jp-banner-inventory";

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(
      "Usage: npm run data:review-jp-banners -- [--pages=1..50] [--start-page=1..5000] [--inspect=0..20] [--resolve-servants] [--project-na]\nRead-only JP news inventory. Defaults to two pages and no article inspection. --resolve-servants matches catalogue identities and explicit pickup statements. --project-na previews reset-relative NA times using one estimated notice anchor and a two-calendar-year shift; it does not verify family identity or NA availability. Both flags require --inspect=1..20. Incomplete rosters and image schedules remain unresolved. No image downloads or publication.",
    );
  } else {
    const options: {
      pages?: number;
      startPage?: number;
      inspect?: number;
      resolveServants?: boolean;
      projectNa?: boolean;
    } = {};
    const seen = new Set<string>();
    for (const argument of process.argv.slice(2)) {
      if (argument === "--resolve-servants" || argument === "--project-na") {
        if (seen.has(argument))
          throw new Error("Duplicate servant resolution argument.");
        seen.add(argument);
        if (argument === "--resolve-servants") options.resolveServants = true;
        else options.projectNa = true;
        continue;
      }
      const match = /^--(pages|start-page|inspect)=(0|[1-9]\d*)$/.exec(
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
            : "startPage"
      ] = Number(match[2]);
    }
    const report = await inventoryJpBannerAnnouncements(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "partial_failure") process.exitCode = 1;
  }
} catch {
  console.error(
    "Could not inventory JP announcements. Use --pages=1..50, --start-page=1..5000 and --inspect=0..20. --resolve-servants and --project-na require --inspect=1..20. No data was published.",
  );
  process.exitCode = 1;
}
