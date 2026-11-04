import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inventoryJpBannerAnnouncements,
  jpBannerArticleUrl,
  JP_BANNER_INVENTORY_LIMITS,
} from "../../src/server/services/jp-banner-inventory";
import {
  JP_BANNER_SERVANT_SOURCE,
  parseJpBannerServantCatalogue,
} from "../../src/server/services/jp-banner-servants";
const MEBIBYTE = 1024 * 1024;
/** @param {Uint8Array} bytes */
const decode = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const limits = {
  manifestBytes: 8 * MEBIBYTE,
  catalogueBytes: 8 * MEBIBYTE,
  totalHtmlBytes: 128 * MEBIBYTE,
  maxNotices: 2000,
};
/** @param {string | Uint8Array} value */
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** @param {string} file @param {number} max */
async function readBounded(file, max) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error("Cached JP input exceeds its file limit.");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > max) throw new Error("Cached JP input exceeds its file limit.");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
/**
 * Substitute saved HTTP responses; inspection, resolution and projection remain shared.
 * @param {string} cacheDir
 * @param {string} catalogueFile
 */
export async function collectCachedJpBannerSources(cacheDir, catalogueFile) {
  const root = await realpath(resolve(cacheDir));
  const manifest = z
    .object({
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
        .max(limits.maxNotices),
    })
    .parse(
      JSON.parse(
        decode(
          await readBounded(
            resolve(root, "manifest.json"),
            limits.manifestBytes,
          ),
        ),
      ),
    );
  if (
    new Set(manifest.articles.map((row) => row.url)).size !==
      manifest.articles.length ||
    manifest.articles.reduce((sum, row) => sum + row.bytes, 0) >
      limits.totalHtmlBytes
  )
    throw new Error("Invalid JP cache scope.");
  for (const row of manifest.articles)
    if (jpBannerArticleUrl(row.url) !== row.url)
      throw new Error("Noncanonical cached JP notice.");
  const catalogue = await readBounded(
    resolve(catalogueFile),
    limits.catalogueBytes,
  );
  const meta = z
    .object({
      sourceUrl: z.literal(JP_BANNER_SERVANT_SOURCE),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .parse(
      JSON.parse(
        decode(
          await readBounded(
            resolve(catalogueFile.replace(/\.json$/u, ".meta.json")),
            64 * 1024,
          ),
        ),
      ),
    );
  if (digest(catalogue) !== meta.contentHash)
    throw new Error("Cached JP catalogue hash differs.");
  parseJpBannerServantCatalogue(JSON.parse(decode(catalogue)));
  const entries = new Map(manifest.articles.map((row) => [row.url, row]));
  let readBytes = 0;
  /** @type {typeof fetch} */
  const fetchFn = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === JP_BANNER_SERVANT_SOURCE)
      return new Response(decode(catalogue), {
        headers: { "content-type": "application/json" },
      });
    const row = entries.get(url);
    if (!row) throw new Error("Uncached JP request forbidden.");
    const file = resolve(root, row.file),
      lexical = relative(root, file);
    const escapes = (/** @type {string} */ path) =>
      path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
    if (escapes(lexical)) throw new Error("Cached JP path escapes its root.");
    const actual = await realpath(file),
      resolved = relative(root, actual);
    if (escapes(resolved)) throw new Error("Cached JP path escapes its root.");
    const body = await readBounded(file, row.bytes);
    readBytes += body.length;
    if (
      readBytes > limits.totalHtmlBytes ||
      body.length !== row.bytes ||
      digest(body) !== row.sha256
    )
      throw new Error("Cached JP notice integrity differs.");
    return new Response(decode(body), {
      headers: { "content-type": "text/html" },
    });
  };
  const reports = [];
  for (
    let offset = 0;
    offset < manifest.articles.length;
    offset += JP_BANNER_INVENTORY_LIMITS.maxArticleInspections
  ) {
    reports.push(
      await inventoryJpBannerAnnouncements(
        {
          articleUrls: manifest.articles
            .slice(
              offset,
              offset + JP_BANNER_INVENTORY_LIMITS.maxArticleInspections,
            )
            .map((row) => row.url),
          resolveServants: true,
          projectNa: true,
        },
        { fetchFn },
      ),
    );
  }
  return reports;
}
