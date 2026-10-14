export const atlasJpServantCatalogueUrl =
  "https://api.atlasacademy.io/export/JP/basic_servant_lang_en.json";
export const atlasNaServantCatalogueUrl =
  "https://api.atlasacademy.io/export/NA/basic_servant.json";

/**
 * @typedef {{ name: string, rarity: number, faceId: number | null }} AtlasServantSummary
 */

/**
 * @param {unknown} value
 * @returns {Map<number, AtlasServantSummary>}
 */
export function parseAtlasServantCatalogue(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("The Atlas Servant catalogue must be an array.");
  }

  /** @type {Map<number, AtlasServantSummary>} */
  const catalogue = new Map();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (item);
    const collectionNo = record.collectionNo;
    const rarity = record.rarity;
    if (
      typeof collectionNo !== "number" ||
      !Number.isSafeInteger(collectionNo) ||
      collectionNo <= 0
    ) {
      continue;
    }
    if (
      typeof rarity !== "number" ||
      !Number.isInteger(rarity) ||
      rarity < 0 ||
      rarity > 5
    ) {
      throw new TypeError(
        `Atlas Servant ${collectionNo} has an invalid rarity.`,
      );
    }

    const match =
      typeof record.face === "string"
        ? /^https:\/\/static\.atlasacademy\.io\/JP\/Faces\/f_(\d+)\.png$/.exec(
            record.face,
          )
        : null;
    const parsedFace = match ? Number(match[1]) : null;
    const faceId =
      parsedFace !== null &&
      Number.isInteger(parsedFace) &&
      parsedFace > 0 &&
      parsedFace <= 2_147_483_647
        ? parsedFace
        : null;
    const existing = catalogue.get(collectionNo);
    if (existing && existing.rarity !== rarity) {
      throw new Error(
        `Atlas Servant ${collectionNo} has conflicting rarities.`,
      );
    }
    if (existing?.faceId && faceId && existing.faceId !== faceId) {
      throw new Error(
        `Atlas Servant ${collectionNo} has conflicting thumbnails.`,
      );
    }
    catalogue.set(collectionNo, {
      faceId: faceId ?? existing?.faceId ?? null,
      name:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : `Servant ${collectionNo}`,
      rarity,
    });
  }

  return catalogue;
}

/**
 * @param {typeof fetch} [fetcher]
 */
export async function downloadAtlasServantCatalogue(fetcher = fetch) {
  return downloadCatalogue(atlasJpServantCatalogueUrl, fetcher);
}

/** @param {string} url @param {typeof fetch} fetcher */
async function downloadCatalogue(url, fetcher) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download the Atlas Servant catalogue: ${response.status}`,
    );
  }
  return parseAtlasServantCatalogue(await response.json());
}

/** @param {typeof fetch} [fetcher] */
export async function downloadAtlasServantCatalogues(fetcher = fetch) {
  const [jp, na] = await Promise.all([
    downloadAtlasServantCatalogue(fetcher),
    downloadCatalogue(atlasNaServantCatalogueUrl, fetcher),
  ]);
  if (!jp.size || !na.size)
    throw new Error("Atlas returned an empty servant catalogue.");
  return new Map(
    [...jp].map(([id, servant]) => [
      id,
      { ...servant, atlasNaAvailable: na.has(id) },
    ]),
  );
}
