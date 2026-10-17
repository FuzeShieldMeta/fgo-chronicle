import { z } from "zod";
import {
  atlasJpServantCatalogueUrl,
  downloadAtlasServantCatalogue,
} from "../../../scripts/lib/atlas-servant-catalogue.mjs";
import {
  BANNER_SPREADSHEET_SHEETS,
  BANNER_SYNC_LIMITS as LIMITS,
} from "~/shared/banner-sync-config.mjs";

const text = z.string().trim().min(1).max(LIMITS.maxTextCharacters);
const id = z.number().int().positive().max(2_147_483_647);
const featured = z.object({
  id,
  name: text,
  class: text,
  rarity: z.number().int().min(0).max(5).nullable().optional(),
  faceId: id.nullable().optional(),
  soloRateUp: z.boolean(),
});
const lineup = z.object({
  sourceKey: text,
  name: text,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  evidenceUrl: z.string().url(),
  sourceRegion: text,
  lastVerifiedAt: z.string().datetime().nullable().optional(),
  servants: z
    .array(z.object({ servantId: id, soloRateUp: z.boolean() }))
    .max(LIMITS.maxFeaturedServants),
});
const banner = z
  .object({
    name: text,
    startDate: z.string().date(),
    endDate: z.string().date().nullable(),
    status: z.enum(["PROJECTED", "CONFIRMED_EN", "OFFICIAL", "CURATED"]),
    sourceSchedule: z.enum(["JP", "NA"]),
    servants: z.array(featured).min(1).max(LIMITS.maxFeaturedServants),
    summonLineups: z.array(lineup).max(LIMITS.maxLineupsPerBanner).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endDate && value.endDate < value.startDate)
      ctx.addIssue({ code: "custom", message: "Invalid banner date range." });
    if (
      (value.status === "CONFIRMED_EN" || value.status === "OFFICIAL") &&
      value.sourceSchedule !== "NA"
    )
      ctx.addIssue({
        code: "custom",
        message: "Official banners require Global source dates.",
      });
    if (
      new Set(value.servants.map((servant) => servant.id)).size !==
      value.servants.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate featured servant." });
    for (const item of value.summonLineups ?? []) {
      if (item.endsAt && item.endsAt < item.startsAt)
        ctx.addIssue({ code: "custom", message: "Invalid lineup date range." });
      if (
        item.servants.some(
          (servant) =>
            !value.servants.some((feature) => feature.id === servant.servantId),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Lineup servant is not featured in this banner.",
        });
    }
    if (
      new Set(value.summonLineups?.map((item) => item.sourceKey)).size !==
      (value.summonLineups?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate lineup source key." });
  });
export function bannerSourceKey(value: {
  name: string;
  startDate: string;
  endDate: string | null;
}) {
  return [
    value.name.trim().toLowerCase(),
    value.startDate,
    value.endDate ?? "",
  ].join(":");
}
export const bannerDatasetSchema = z
  .object({
    importedAt: z.string().datetime().optional(),
    banners: z.array(banner).min(1).max(LIMITS.maxBanners),
  })
  .superRefine((value, ctx) => {
    if (
      value.banners.reduce(
        (count, banner) => count + banner.servants.length,
        0,
      ) > LIMITS.maxFeaturedMemberships ||
      value.banners.reduce(
        (count, banner) => count + (banner.summonLineups?.length ?? 0),
        0,
      ) > LIMITS.maxTotalLineups
    )
      ctx.addIssue({
        code: "custom",
        message: "Banner dataset exceeds publication limits.",
      });
    if (
      new Set(value.banners.map(bannerSourceKey)).size !== value.banners.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate banner source key." });
  });
export type BannerDataset = z.infer<typeof bannerDatasetSchema>;

export function parseBannerCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > LIMITS.maxRowsPerSheet)
        throw new Error("Spreadsheet row limit exceeded.");
    } else field += char;
  }
  if (quoted) throw new Error("Unterminated spreadsheet CSV field.");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows.length > LIMITS.maxRowsPerSheet)
    throw new Error("Spreadsheet row limit exceeded.");
  return rows;
}
function date(value: string | undefined) {
  if (!value?.trim()) return null;
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("Unsupported spreadsheet date.");
  return z.string().date().parse(`${match[1]}-${match[2]}-${match[3]}`);
}
async function sheetCsv(sheetId: string, sheet: string, fetchFn: typeof fetch) {
  const url = new URL(
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`,
  );
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("sheet", sheet);
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  if (
    !response.ok ||
    !response.body ||
    /text\/html/i.test(response.headers.get("content-type") ?? "")
  ) {
    await response.body?.cancel();
    throw new Error("Spreadsheet download failed.");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.maxCsvBytes)
        throw new Error("Spreadsheet response limit exceeded.");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function downloadBannerSpreadsheet(
  options: { spreadsheetId?: string; fetchFn?: typeof fetch } = {},
) {
  const sheetId = options.spreadsheetId ?? process.env.BANNER_SPREADSHEET_ID;
  if (
    !sheetId ||
    !/^[A-Za-z0-9_-]+$/.test(sheetId) ||
    sheetId.length > LIMITS.maxTextCharacters
  )
    throw new Error("BANNER_SPREADSHEET_ID is not configured correctly.");
  const fetchFn = options.fetchFn ?? fetch;
  const [catalogue, sheets] = await Promise.all([
    downloadAtlasServantCatalogue(fetchFn),
    Promise.all(
      BANNER_SPREADSHEET_SHEETS.map(async (sheet) => ({
        sheet,
        rows: parseBannerCsv(await sheetCsv(sheetId, sheet, fetchFn)),
      })),
    ),
  ]);
  type PendingBanner = Omit<
    BannerDataset["banners"][number],
    "status" | "sourceSchedule"
  > & { regions: Set<"JP" | "NA"> };
  const banners = new Map<string, PendingBanner>();
  for (const { sheet, rows } of sheets)
    for (const row of rows.slice(1)) {
      const servantId = Number(row[0]?.trim()),
        servantName = row[1]?.trim();
      if (!row[0]?.trim() || !servantName) continue;
      for (let column = 3; column + 4 < row.length; column += 5) {
        const name = row[column]?.trim(),
          startDate = date(row[column + 3]),
          endDate = date(row[column + 4]);
        if (!name || !startDate) continue;
        const sourceSchedule = row[column + 2]?.trim().toUpperCase() ?? "";
        if (
          sourceSchedule !== "" &&
          sourceSchedule !== "JP" &&
          sourceSchedule !== "NA"
        )
          throw new Error("Unsupported spreadsheet region.");
        const sourceKey = bannerSourceKey({ name, startDate, endDate });
        const existing = banners.get(sourceKey) ?? {
          name,
          startDate,
          endDate,
          regions: new Set<"JP" | "NA">(),
          servants: [],
        };
        if (sourceSchedule) existing.regions.add(sourceSchedule);
        if (!existing.servants.some((servant) => servant.id === servantId)) {
          const servant = catalogue.get(servantId);
          if (!servant)
            throw new Error("Spreadsheet servant is missing from Atlas.");
          existing.servants.push({
            id: servantId,
            name: servantName,
            class: sheet,
            rarity: servant.rarity,
            faceId: servant.faceId,
            soloRateUp: row[column + 1]?.trim() === "Yes",
          });
        }
        banners.set(sourceKey, existing);
      }
    }
  const output = [...banners.values()]
    .map(({ regions, ...banner }) => {
      if (regions.size !== 1)
        throw new Error("Missing or conflicting spreadsheet regions.");
      const sourceSchedule = [...regions][0]!;
      return {
        ...banner,
        sourceSchedule,
        status:
          sourceSchedule === "JP"
            ? ("PROJECTED" as const)
            : ("CONFIRMED_EN" as const),
      };
    })
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name),
    );
  const dataset = { importedAt: new Date().toISOString(), banners: output };
  bannerDatasetSchema.parse(dataset);
  return {
    ...dataset,
    count: output.length,
    note: "PROJECTED dates are already JP dates shifted approximately two years by the sheet maintainers.",
    servantCatalogueUrl: atlasJpServantCatalogueUrl,
  };
}
