import { readBoundedFile } from "./lib/file-input.mjs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PrismaClient } from "../generated/prisma";
import {
  GLOBAL_BANNER_PUBLICATION_LIMITS as LIMITS,
  GLOBAL_ANNOUNCEMENT_LIMITS,
} from "../src/shared/global-reconciliation-config";
import { parsePublisherAnnouncement } from "../src/server/services/global-announcement-parser";
import {
  downloadAtlasServantCatalogues,
  atlasJpServantCatalogueUrl,
  atlasNaServantCatalogueUrl,
} from "./lib/atlas-servant-catalogue.mjs";
import {
  globalBannerReviewSchema,
  previewGlobalBannerPublication,
  publishGlobalBannerSources,
} from "../src/server/services/global-banner-publication";

const usage =
  "Usage: npm run data:review-global-banners -- <preview|apply> --review=FILE [--output=NEW_FILE] [--actor-id=ID --confirm]\nThe file supplies sourceHtml, jpCatalogue, naCatalogue and review. Set the review acknowledgements before taking a fresh preview. Preview adds an acceptance template; fill its reason before apply. Apply requires --actor-id and --confirm. Files are replayed locally; this command never downloads sources or applies migrations.";
const fileSchema = z
  .object({
    sourceHtml: z.string().min(1),
    jpCatalogue: z.string().min(1),
    naCatalogue: z.string().min(1),
    review: globalBannerReviewSchema,
    acceptance: z
      .object({
        expectedDatabaseFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        reason: z.string(),
      })
      .strict()
      .optional(),
    preview: z.unknown().optional(),
  })
  .strict();
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
let database: PrismaClient | undefined;
try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode !== "preview" && mode !== "apply") throw new Error("USAGE");
  const options = new Map<string, string>();
  let confirm = false;
  for (const arg of args) {
    if (arg === "--confirm" && !confirm) {
      confirm = true;
      continue;
    }
    const match = /^--(review|output|actor-id)=(.+)$/u.exec(arg);
    if (!match || options.has(match[1]!)) throw new Error("USAGE");
    options.set(match[1]!, match[2]!);
  }
  const file = options.get("review");
  if (
    !file ||
    (mode === "apply" &&
      (!confirm || !options.get("actor-id") || options.has("output"))) ||
    (mode === "preview" && (confirm || options.has("actor-id")))
  )
    throw new Error("USAGE");
  const path = resolve(file),
    root = dirname(path);
  const input = fileSchema.parse(
    JSON.parse(
      decode(await readBoundedFile(path, LIMITS.maxReviewBytes)),
    ) as unknown,
  );
  const sourceHtml = resolve(root, input.sourceHtml),
    jpCatalogue = resolve(root, input.jpCatalogue),
    naCatalogue = resolve(root, input.naCatalogue);
  const article = parsePublisherAnnouncement(
    decode(
      await readBoundedFile(
        sourceHtml,
        GLOBAL_ANNOUNCEMENT_LIMITS.maxBodyBytes,
      ),
    ),
    input.review.sourceUrl,
    new Date(),
  );
  const exports = new Map([
    [atlasJpServantCatalogueUrl, jpCatalogue],
    [atlasNaServantCatalogueUrl, naCatalogue],
  ]);
  const catalogue = await downloadAtlasServantCatalogues(async (target) => {
    const url = target instanceof Request ? target.url : target.toString(),
      cached = exports.get(url);
    if (!cached) throw new Error("Uncached source request.");
    return new Response(
      decode(await readBoundedFile(cached, LIMITS.maxCatalogueBytes)),
      { headers: { "content-type": "application/json" } },
    );
  });
  database = new PrismaClient({ log: [] });
  if (mode === "apply") {
    if (!input.acceptance) throw new Error("USAGE");
    const result = await publishGlobalBannerSources(
      database,
      options.get("actor-id")!,
      article,
      catalogue,
      { ...input.review, ...input.acceptance },
    );
    console.log(JSON.stringify(result, null, 2));
  } else {
    const preview = await previewGlobalBannerPublication(
      database,
      article,
      catalogue,
      input.review,
    );
    const result = {
      sourceHtml,
      jpCatalogue,
      naCatalogue,
      review: input.review,
      acceptance: {
        expectedDatabaseFingerprint: preview.databaseFingerprint,
        reason: "",
      },
      preview,
    };
    const body = JSON.stringify(result, null, 2) + "\n";
    const output = options.get("output");
    if (output)
      await writeFile(resolve(output), body, { flag: "wx", mode: 0o600 });
    else console.log(body);
  }
} catch (error) {
  if (error instanceof Error && error.message === "USAGE") console.error(usage);
  else if (error instanceof TRPCError) console.error(error.message);
  else if (error instanceof z.ZodError) {
    const fields = [
      ...new Set(
        error.issues.map(
          (issue) => issue.path.map(String).join(".") || "(root)",
        ),
      ),
    ];
    console.error(`Invalid review fields: ${fields.join(", ")}`);
  } else
    console.error(
      "Could not review Global banners. Check the source files and database configuration.",
    );
  process.exitCode = 1;
} finally {
  await database?.$disconnect();
}
