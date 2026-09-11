export const atlasJpServantCatalogueUrl =
  "https://api.atlasacademy.io/export/JP/basic_servant_lang_en.json";

/**
 * @typedef {{ name: string, rarity: number }} AtlasServantSummary
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

    const existing = catalogue.get(collectionNo);
    if (existing && existing.rarity !== rarity) {
      throw new Error(
        `Atlas Servant ${collectionNo} has conflicting rarities.`,
      );
    }
    catalogue.set(collectionNo, {
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
  const response = await fetcher(atlasJpServantCatalogueUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download the Atlas Servant catalogue: ${response.status}`,
    );
  }
  return parseAtlasServantCatalogue(await response.json());
}
