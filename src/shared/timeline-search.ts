import { servantSearchAliases } from "./servant-search-aliases";

export const timelineSearchLimits = {
  minimumQueryCharacters: 2,
  maximumQueryCharacters: 100,
  maximumResults: 40,
  debounceMs: 250,
} as const;

export type TimelineSearchEntry = {
  key: string;
  name: string;
  kind: "EVENT" | "BANNER";
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: "EXACT" | "DATE_ONLY";
  endsAtPrecision: "EXACT" | "DATE_ONLY" | null;
  status: "OFFICIAL" | "CURATED" | "PROJECTED";
  servants: {
    id: number;
    name: string;
    className: string;
    thumbnailUrl?: string | null;
  }[];
};

export function normaliseSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const familyAliases = servantSearchAliases.families.map(
  ({ name, aliases }) => ({
    name: normaliseSearchText(name),
    aliases: aliases.map(normaliseSearchText),
  }),
);

type SearchServant = TimelineSearchEntry["servants"][number];

/** One matcher for both result inclusion and matching-name emphasis. */
export function servantMatchesSearch(servant: SearchServant, query: string) {
  const normalised = normaliseSearchText(query);
  if (normalised.length < timelineSearchLimits.minimumQueryCharacters)
    return false;
  const tokens = normalised.split(/\s+/u);
  const name = normaliseSearchText(servant.name);
  const candidates = [name];
  // Padding enforces whole name-phrase boundaries without dynamic regexes.
  for (const family of familyAliases) {
    const padded = ` ${name} `;
    const phrase = ` ${family.name} `;
    if (!padded.includes(phrase)) continue;
    for (const alias of family.aliases) {
      candidates.push(padded.replace(phrase, ` ${alias} `).trim());
    }
  }
  candidates.push(
    ...(servantSearchAliases.servants[servant.id] ?? []).map(
      normaliseSearchText,
    ),
  );
  const className = normaliseSearchText(servant.className);
  return candidates.some((candidate) =>
    tokens.every((token) => `${candidate} ${className}`.includes(token)),
  );
}

export function searchTimelineEntries(
  entries: readonly TimelineSearchEntry[],
  query: string,
) {
  const normalised = normaliseSearchText(query);
  if (normalised.length < timelineSearchLimits.minimumQueryCharacters)
    return { results: [], hasMore: false };
  const tokens = normalised.split(/\s+/u);
  const matches = entries
    .filter((entry) => {
      const name = normaliseSearchText(entry.name);
      return (
        tokens.every((token) => name.includes(token)) ||
        entry.servants.some((servant) => servantMatchesSearch(servant, query))
      );
    })
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        a.key.localeCompare(b.key),
    );
  return {
    results: matches.slice(0, timelineSearchLimits.maximumResults),
    hasMore: matches.length > timelineSearchLimits.maximumResults,
  };
}
