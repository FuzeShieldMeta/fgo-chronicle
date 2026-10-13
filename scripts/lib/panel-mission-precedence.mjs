/** @param {Record<string, any>} source @param {boolean} atlas */
function panelNumber(source, atlas) {
  const name = (source.name ?? "").normalize("NFKC");
  if (!atlas) {
    const match = name.match(/^Panel Missions: mission (\d+)\b/i);
    const number = match ? Number(match[1]) : null;
    return number !== null && Number.isSafeInteger(number) ? number : null;
  }
  if (source.type !== "LIMITED_MISSION") return null;
  const match = name.match(/^【(\d+)】/);
  if (match) {
    const number = Number(match[1]);
    return Number.isSafeInteger(number) ? number : null;
  }
  return /パネルミッション.*コンプリート/.test(name) ? 0 : null;
}

/**
 * Require a complete numbered panel set, including its completion reward.
 * Amounts alone or coincident dates do not establish mission identity.
 * @param {Record<string, any>} dataset
 * @param {boolean} atlas
 */
function panelSets(dataset, atlas) {
  const grouped = new Map();
  for (const source of dataset.rewardSources) {
    const number = panelNumber(source, atlas);
    const eventKey = source.eventSourceKey ?? source.externalEventSourceKey;
    if (number === null || !eventKey) continue;
    const sources = grouped.get(eventKey) ?? [];
    sources.push({ source, number });
    grouped.set(eventKey, sources);
  }
  return dataset.events.flatMap((/** @type {Record<string, any>} */ event) => {
    if (
      (dataset.issues ?? []).some(
        (/** @type {Record<string, any>} */ issue) =>
          issue.severity === "ERROR" &&
          (issue.sourceKey.startsWith(event.sourceKey) ||
            (event.evidenceSourceKey &&
              issue.sourceKey.startsWith(event.evidenceSourceKey))),
      )
    )
      return [];
    const sources = grouped.get(event.sourceKey) ?? [];
    const numbers = new Set(
      sources.map((/** @type {any} */ row) => row.number),
    );
    if (!numbers.has(0) || numbers.size < 2 || numbers.size !== sources.length)
      return [];
    const panels = sources
      .map((/** @type {any} */ { source, number }) => [
        number,
        source.rewards
          .map((/** @type {any} */ reward) => [
            reward.itemType,
            reward.amount,
            reward.defaultIncluded,
            reward.expectedAt?.slice(0, 16),
          ])
          .sort(),
      ])
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a[0] - b[0]);
    return [
      {
        signature: JSON.stringify([
          event.startsAt?.slice(0, 16),
          event.endsAt?.slice(0, 16),
          panels,
        ]),
        sources: sources.map((/** @type {any} */ row) => row.source.sourceKey),
      },
    ];
  });
}

/**
 * Prefer structured Atlas event missions only for a unique, identical panel
 * set. Leave partial, conflicting and ambiguous sets available for review.
 * This does not replace shop rewards, login gifts or trial quests.
 * @param {Record<string, any>} fandom
 * @param {Record<string, any>} atlas
 */
export function preferAtlasPanelMissions(fandom, atlas) {
  const atlasSets = panelSets(atlas, true);
  const fandomSets = panelSets(fandom, false);
  const suppressed = new Set();
  for (const set of fandomSets) {
    if (
      atlasSets.filter(
        (/** @type {any} */ other) => other.signature === set.signature,
      ).length === 1 &&
      fandomSets.filter(
        (/** @type {any} */ other) => other.signature === set.signature,
      ).length === 1
    ) {
      for (const key of set.sources) suppressed.add(key);
    }
  }
  return {
    ...fandom,
    rewardSources: fandom.rewardSources.filter(
      (/** @type {any} */ source) => !suppressed.has(source.sourceKey),
    ),
  };
}
