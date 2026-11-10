const CLASS_SUFFIXES = new Map([
  ["セイバー", "saber"],
  ["アーチャー", "archer"],
  ["ランサー", "lancer"],
  ["ライダー", "rider"],
  ["キャスター", "caster"],
  ["アサシン", "assassin"],
  ["バーサーカー", "berserker"],
  ["ルーラー", "ruler"],
  ["アヴェンジャー", "avenger"],
  ["ムーンキャンサー", "moonCancer"],
  ["アルターエゴ", "alterEgo"],
  ["フォーリナー", "foreigner"],
  ["プリテンダー", "pretender"],
  ["シールダー", "shielder"],
  ["ビースト", "beast"],
]);

export type ServantCatalogueEntry = {
  collectionNo: number;
  name: string;
  originalName: string;
  aliases?: readonly string[];
  rarity: number;
  className: string;
};

export const normalizeServantName = (name: string) =>
  name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export function servantNameIndex(catalogue: readonly ServantCatalogueEntry[]) {
  const names = new Map<string, ServantCatalogueEntry[]>();
  for (const servant of catalogue) {
    for (const name of new Set([
      normalizeServantName(servant.name),
      normalizeServantName(servant.originalName),
      ...(servant.aliases ?? []).map(normalizeServantName),
    ])) {
      const group = names.get(name) ?? [];
      if (
        !group.some(
          (candidate) => candidate.collectionNo === servant.collectionNo,
        )
      )
        group.push(servant);
      names.set(name, group);
    }
  }
  return names;
}

export function lookupServantName(
  name: string,
  names: ReturnType<typeof servantNameIndex>,
) {
  const normalized = normalizeServantName(name);
  const exact = names.get(normalized);
  if (exact?.length)
    return { named: exact, classHint: null, nameParts: [normalized] };
  // Keep the longest exact catalogue prefix, including literal variant suffixes.
  // Each remaining parenthesis must name the same identity or constrain its class.
  const openings = [...normalized.matchAll(/\(/gu)].map((match) => match.index);
  for (const index of openings.reverse()) {
    const base = normalized.slice(0, index);
    const suffix = normalized.slice(index);
    const prefix = names.get(base);
    if (!prefix?.length || !/^(?:\([^()]+\))+$/u.test(suffix)) continue;
    let named = prefix;
    let classHint: { label: string; className: string } | null = null;
    const nameParts = [base];
    for (const match of suffix.matchAll(/\(([^()]+)\)/gu)) {
      const part = match[1]!;
      const className = CLASS_SUFFIXES.get(part);
      if (className) {
        classHint ??= { label: part, className };
        named = named.filter((servant) => servant.className === className);
      } else {
        const aliases = names.get(part);
        if (!aliases?.length) return { named: [], classHint, nameParts };
        const ids = new Set(aliases.map((servant) => servant.collectionNo));
        named = named.filter((servant) => ids.has(servant.collectionNo));
        nameParts.push(part);
      }
    }
    return { named, classHint, nameParts };
  }
  return { named: [], classHint: null, nameParts: [normalized] };
}
