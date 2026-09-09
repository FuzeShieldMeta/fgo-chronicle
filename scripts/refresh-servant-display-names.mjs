import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const sourceUrl =
  "https://api.atlasacademy.io/export/JP/basic_svt_lang_en.json";
const sourceFile = process.argv[2];
if (!sourceFile)
  throw new Error("Provide a downloaded Atlas JP English servant export file.");
const servants = z
  .array(
    z.object({
      type: z.string(),
      collectionNo: z.number(),
      name: z.string(),
      originalName: z.string(),
    }),
  )
  .min(1)
  .parse(JSON.parse(await readFile(sourceFile, "utf8")));
const candidates = new Map();
for (const servant of servants) {
  if (
    servant.type !== "normal" ||
    servant.collectionNo <= 0 ||
    servant.name === servant.originalName ||
    /[\u3040-\u30ff\u3400-\u9fff]/u.test(servant.name)
  )
    continue;
  const names = candidates.get(servant.originalName) ?? new Set();
  names.add(servant.name);
  candidates.set(servant.originalName, names);
}
const names = Object.fromEntries(
  [...candidates]
    .filter(([, names]) => names.size === 1)
    .map(([original, names]) => [original, [...names][0]]),
);
await writeFile(
  new URL("../src/data/atlas-servant-names.json", import.meta.url),
  JSON.stringify({ sourceUrl, names }, null, 2) + "\n",
);
console.log(
  `Saved ${Object.keys(names).length} unambiguous English servant names.`,
);
