import {
  hasCompletedStory,
  type StoryChapter,
  type StoryProgress,
} from "./story-progress";

const chapterIndices = new WeakMap<StoryChapter[], Map<string, Set<number>>>();

function normalise(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function chapterIndex(catalogue: StoryChapter[]) {
  const cached = chapterIndices.get(catalogue);
  if (cached) return cached;
  const index = new Map<string, Set<number>>();
  for (const chapter of catalogue) {
    const names = [chapter.name, chapter.originalName];
    const identifier = chapter.originalName.split("\n")[0];
    if (identifier) names.push(identifier);
    // Catalogue titles can explicitly supply a short name and a subtitle.
    if (chapter.name.includes(":")) names.push(...chapter.name.split(":"));
    for (const name of names) {
      const key = normalise(name);
      if (!key) continue;
      const ids = index.get(key) ?? new Set<number>();
      ids.add(chapter.warId);
      index.set(key, ids);
    }
  }
  chapterIndices.set(catalogue, index);
  return index;
}

export type StoryEligibility = {
  completed: boolean | null;
  requiredChapters: StoryChapter[];
};

/** Read explicit requirements, not incidental chapter mentions or quest names. */
export function storyEligibility(
  eligibility: string | null | undefined,
  progress: StoryProgress,
  catalogue: StoryChapter[],
): StoryEligibility | null {
  if (!eligibility) return null;
  const text = eligibility.normalize("NFKC").replace(/\s+/g, " ").trim();
  const requirement =
    /(?:^|[.;]\s*)(?:requirements?|prerequisites?)\s*:\s*(.+)$/i.exec(text);
  const body = requirement?.[1] ?? text;
  // Do not turn disjunctions or negations into AND conditions.
  if (
    /\b(?:or|either|not|without|unless|excluding|excluded|except)\b/i.test(body)
  )
    return requirement ? { completed: null, requiredChapters: [] } : null;
  if (!requirement && !/^(?:clear|complete)\s+/i.test(body)) return null;
  const clauses = body
    .replace(/\.$/, "")
    .split(/\s*(?:&|;|\band\b|\.\s+(?=clear\b|complete\b))\s*/i);
  const index = chapterIndex(catalogue);
  const warIds = new Set<number>();
  let unresolved = false;
  for (const clause of clauses) {
    const subject = clause
      .replace(/^(?:clear|complete)\s+/i, "")
      .replace(
        /\s+(?:before|by)\s+(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})(?:\s+\d{1,2}:\d{2})?(?:\s+(?:JST|UTC|PDT|PST))?\.?$/i,
        "",
      )
      .replace(/^(?:main quests?\s*:\s*)/i, "");
    const ids = index.get(normalise(subject));
    if (ids?.size === 1) warIds.add([...ids][0]!);
    else unresolved = true;
  }
  // Without a labelled prerequisite, the entire objective must be a known
  // chapter-clear expression. A chapter in a mission's scope is not a gate.
  if (!requirement && unresolved) return null;
  // An explicit but unrecognised prerequisite needs a player decision. An
  // unknown quest objective is not assumed to be a story prerequisite.
  if (!warIds.size)
    return requirement ? { completed: null, requiredChapters: [] } : null;
  const requiredChapters = catalogue.filter((chapter) =>
    warIds.has(chapter.warId),
  );
  const completion = requiredChapters.map((chapter) =>
    hasCompletedStory(chapter.warId, progress, catalogue),
  );
  return {
    requiredChapters,
    completed: completion.includes(false)
      ? false
      : unresolved || completion.includes(null)
        ? null
        : true,
  };
}
