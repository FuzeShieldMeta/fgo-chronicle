import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  auditJpBannerEvidence,
  jpBannerAuditOptionsSchema,
  JP_BANNER_AUDIT_LIMITS,
} from "../src/server/services/jp-banner-audit";
import {
  inventoryJpBannerAnnouncements,
  jpBannerArticleUrl,
  JP_BANNER_INVENTORY_LIMITS,
} from "../src/server/services/jp-banner-inventory";
import {
  JP_BANNER_SERVANT_SOURCE,
  parseJpBannerServantCatalogue,
} from "../src/server/services/jp-banner-servants";
import { JP_BANNER_COMPARISON_LIMITS } from "../src/server/services/jp-banner-comparison";
import { bannerDatasetSchema } from "../src/server/services/banner-dataset";
const MEBIBYTE = 1_024 * 1_024;
const limits = {
  manifestBytes: 8 * MEBIBYTE,
  catalogueBytes: 8 * MEBIBYTE,
  totalHtmlBytes: 128 * MEBIBYTE,
  reportBytes: 32 * MEBIBYTE,
} as const;
const manifestSchema = z.object({
  version: z.literal(1),
  listedFrom: z.iso.date(),
  listedThrough: z.iso.date(),
  articles: z
    .array(
      z.object({
        url: z.string().min(1).max(500),
        file: z.string().min(1).max(500),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(JP_BANNER_INVENTORY_LIMITS.maxBodyBytes),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1)
    .max(JP_BANNER_AUDIT_LIMITS.maxNotices),
});
async function readBounded(file: string, max: number) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error("Local input exceeds its file limit.");
    const buffer = Buffer.alloc(max + 1);
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
    if (length > max) throw new Error("Local input exceeds its file limit.");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: npm run data:audit-jp-banners -- --cache=HTML_CORPUS_DIR --catalogue=JP_CATALOGUE.json --compare=BANNER_DATASET.json --from=YYYY-MM-DD --through=YYYY-MM-DD [--sheet-time-zone=IANA_ZONE]\nRead-only, offline whole-period evidence audit. Uses the same inspection/resolution/projection as online review, in bounded batches. Cache manifest entries must have URL/file/bytes/SHA-256. Missing, corrupt or unsupported sources are reported as incomplete; there is no live fallback. Every JP baseline row and parsed source window is accounted for; NA rows are separate. All matches remain review candidates. Date-only sheet timezone is unknown unless explicitly supplied as an audit assumption. No database, registration, publication or cron work. JSON goes to stdout; exit 0 only for COMPARED, exit 1 for INCOMPLETE or REVIEW_REQUIRED. Date flags select the baseline horizon, not cache discovery dates. The cache manifest's listing interval and unverified archive/image coverage are reported separately.",
    );
  } else {
    const flags = new Map<string, string>();
    for (const arg of args) {
      const match =
        /^--(cache|catalogue|compare|from|through|sheet-time-zone)=(.+)$/u.exec(
          arg,
        );
      if (!match || flags.has(match[1]!))
        throw new Error("Invalid or duplicate audit argument.");
      flags.set(match[1]!, match[2]!);
    }
    for (const key of ["cache", "catalogue", "compare", "from", "through"])
      if (!flags.has(key)) throw new Error("Missing audit argument.");
    const options = jpBannerAuditOptionsSchema.parse({
      from: flags.get("from"),
      through: flags.get("through"),
      ...(flags.has("sheet-time-zone")
        ? { sheetTimeZone: flags.get("sheet-time-zone") }
        : {}),
    });
    const root = await realpath(resolve(flags.get("cache")!));
    const manifest = manifestSchema.parse(
      JSON.parse(
        decode(
          await readBounded(
            resolve(root, "manifest.json"),
            limits.manifestBytes,
          ),
        ),
      ) as unknown,
    );
    if (manifest.listedFrom > manifest.listedThrough)
      throw new Error("Invalid cache interval.");
    if (
      new Set(manifest.articles.map((row) => row.url)).size !==
      manifest.articles.length
    )
      throw new Error("Duplicate cache source.");
    const catalogue = decode(
      await readBounded(
        resolve(flags.get("catalogue")!),
        limits.catalogueBytes,
      ),
    );
    parseJpBannerServantCatalogue(JSON.parse(catalogue) as unknown);
    const baseline = bannerDatasetSchema.parse(
      JSON.parse(
        decode(
          await readBounded(
            resolve(flags.get("compare")!),
            JP_BANNER_COMPARISON_LIMITS.maxBaselineBytes,
          ),
        ),
      ) as unknown,
    );
    if (
      manifest.articles.reduce((total, entry) => total + entry.bytes, 0) >
      limits.totalHtmlBytes
    )
      throw new Error("Total cached HTML budget exceeded.");
    const unavailable: { url: string; reason: string }[] = [],
      selected: string[] = [];
    const entries = new Map(manifest.articles.map((row) => [row.url, row]));
    for (const row of manifest.articles) {
      try {
        if (jpBannerArticleUrl(row.url) !== row.url)
          throw new Error("Noncanonical source");
        selected.push(row.url);
      } catch {
        unavailable.push({
          url: row.url,
          reason: "UNSUPPORTED_CACHED_NOTICE_URL",
        });
      }
    }
    let htmlBytes = 0,
      htmlReads = 0,
      catalogueReads = 0;
    const fetchFn: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === JP_BANNER_SERVANT_SOURCE) {
        catalogueReads++;
        return new Response(catalogue, {
          headers: { "content-type": "application/json" },
        });
      }
      const entry = entries.get(url);
      if (!entry) throw new Error("Uncached source forbidden.");
      const candidate = resolve(root, entry.file),
        path = relative(root, candidate);
      if (path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path))
        throw new Error("Cache file outside corpus.");
      const canonical = await realpath(candidate),
        canonicalRelative = relative(root, canonical);
      if (
        canonicalRelative.startsWith(`..${sep}`) ||
        canonicalRelative === ".." ||
        isAbsolute(canonicalRelative)
      )
        throw new Error("Cache symlink outside corpus.");
      const bytes = await readBounded(canonical, entry.bytes);
      htmlBytes += bytes.length;
      if (htmlBytes > limits.totalHtmlBytes)
        throw new Error("Total cached HTML budget exceeded.");
      if (
        bytes.length !== entry.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      )
        throw new Error("Cached source integrity mismatch.");
      htmlReads++;
      return new Response(decode(bytes), {
        headers: { "content-type": "text/html" },
      });
    };
    const reports = [];
    for (
      let offset = 0;
      offset < selected.length;
      offset += JP_BANNER_INVENTORY_LIMITS.maxArticleInspections
    ) {
      reports.push(
        await inventoryJpBannerAnnouncements(
          {
            articleUrls: selected.slice(
              offset,
              offset + JP_BANNER_INVENTORY_LIMITS.maxArticleInspections,
            ),
            resolveServants: true,
            projectNa: true,
          },
          { fetchFn },
        ),
      );
    }
    const audit = auditJpBannerEvidence(
      reports,
      baseline,
      options,
      unavailable,
    );
    const result = {
      ...audit,
      sourceCache: {
        listedFrom: manifest.listedFrom,
        listedThrough: manifest.listedThrough,
        requestedNotices: manifest.articles.length,
        htmlReads,
        htmlBytes,
        catalogueReads,
        catalogueContentHash: createHash("sha256")
          .update(catalogue)
          .digest("hex"),
        liveRequests: 0,
      },
      checkedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(result, null, 2);
    if (Buffer.byteLength(json) > limits.reportBytes)
      throw new Error(
        "Audit output exceeds its limit; use narrower reviewed inputs.",
      );
    console.log(json);
    if (audit.status !== "COMPARED") process.exitCode = 1;
  }
} catch (error) {
  console.error(
    error instanceof Error &&
      /^(Invalid|Missing|Duplicate|Unsupported|Reversed|Audit |Local input|Total cached|Cache |Cached source|Noncanonical)/u.test(
        error.message,
      )
      ? error.message
      : "Could not audit cached JP notices. Use --help; no network requests or data writes are performed.",
  );
  process.exitCode = 1;
}
