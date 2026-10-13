import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  atlasJpServantCatalogueUrl,
  downloadAtlasServantCatalogue,
} from "./lib/atlas-servant-catalogue.mjs";

const spreadsheetId = process.env.BANNER_SPREADSHEET_ID?.trim();

if (!spreadsheetId) {
  throw new Error("BANNER_SPREADSHEET_ID is required");
}
const sheets = [
  "Saber",
  "Archer",
  "Lancer",
  "Rider",
  "Caster",
  "Assassin",
  "Berserker",
  "EXTRA",
  "EXTRA I",
  "EXTRA II",
];

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

function isoDate(value) {
  if (!value) return null;
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) throw new Error(`Unsupported date: ${value}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

async function fetchSheet(sheet) {
  const url = new URL(
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`,
  );
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("sheet", sheet);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sheet}: ${response.status}`);
  }

  return parseCsv(await response.text());
}

const banners = new Map();
const servantCatalogue = await downloadAtlasServantCatalogue();

for (const sheet of sheets) {
  const rows = await fetchSheet(sheet);

  for (const row of rows.slice(1)) {
    const servantId = row[0]?.trim();
    const servantName = row[1]?.trim();
    if (!servantId || !servantName) continue;

    for (let column = 3; column + 4 < row.length; column += 5) {
      const bannerName = row[column]?.trim();
      const solo = row[column + 1]?.trim();
      const schedule = row[column + 2]?.trim().toUpperCase();
      const startDate = isoDate(row[column + 3]?.trim());
      const endDate = isoDate(row[column + 4]?.trim());
      if (!bannerName || !startDate) continue;

      const key = [bannerName, startDate, endDate ?? ""].join("|");
      const existing = banners.get(key) ?? {
        name: bannerName,
        startDate,
        endDate,
        status: schedule === "JP" ? "PROJECTED" : "CONFIRMED_EN",
        sourceSchedule: schedule,
        servants: [],
      };

      if (
        !existing.servants.some((servant) => servant.id === Number(servantId))
      ) {
        const atlasServant = servantCatalogue.get(Number(servantId));
        if (!atlasServant) {
          throw new Error(
            `Atlas has no Servant rarity for collection number ${servantId}.`,
          );
        }
        existing.servants.push({
          id: Number(servantId),
          name: servantName,
          class: sheet,
          rarity: atlasServant.rarity,
          faceId: atlasServant.faceId,
          soloRateUp: solo === "Yes",
        });
      }

      banners.set(key, existing);
    }
  }
}

const output = [...banners.values()].sort(
  (left, right) =>
    left.startDate.localeCompare(right.startDate) ||
    left.name.localeCompare(right.name),
);

const outputDirectory = path.resolve("data");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "banner-estimates.json"),
  `${JSON.stringify(
    {
      importedAt: new Date().toISOString(),
      note: "PROJECTED dates are already JP dates shifted approximately two years by the sheet maintainers.",
      servantCatalogueUrl: atlasJpServantCatalogueUrl,
      count: output.length,
      banners: output,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Imported ${output.length} unique banners into data/banner-estimates.json`,
);
