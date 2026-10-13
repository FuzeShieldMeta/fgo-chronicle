export type FeaturedServant = {
  id: number;
  name: string;
  rarity: number | null;
  thumbnailUrl?: string | null;
};

export function sortFeaturedServants<T extends FeaturedServant>(
  servants: readonly T[],
): T[] {
  return [...servants].sort(
    (a, b) => (b.rarity ?? -1) - (a.rarity ?? -1) || a.id - b.id,
  );
}
