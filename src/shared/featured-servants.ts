export type FeaturedServant = {
  id: number;
  name: string;
  rarity: number | null;
  thumbnailUrl?: string | null;
  atlasNaAvailable?: boolean | null;
};

export function servantAtlasUrl(
  servant: Pick<FeaturedServant, "id" | "atlasNaAvailable">,
) {
  const region = servant.atlasNaAvailable === true ? "NA" : "JP";
  return `https://apps.atlasacademy.io/db/${region}/servant/${servant.id}/skill-1`;
}

export function sortFeaturedServants<T extends FeaturedServant>(
  servants: readonly T[],
): T[] {
  return [...servants].sort(
    (a, b) => (b.rarity ?? -1) - (a.rarity ?? -1) || a.id - b.id,
  );
}

export function fitServantThumbnails({
  count,
  freeWidth,
  size,
  gap,
  overflowWidth,
}: {
  count: number;
  freeWidth: number;
  size: number;
  gap: number;
  overflowWidth: number;
}) {
  if (size <= 0 || freeWidth <= 0 || !Number.isFinite(freeWidth)) return 0;
  for (let visible = count; visible > 0; visible--) {
    const width =
      visible * size +
      (visible - 1) * gap +
      (visible < count ? gap + overflowWidth : 0);
    if (width <= freeWidth) return visible;
  }
  return 0;
}
