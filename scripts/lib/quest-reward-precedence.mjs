import { plainWikitext } from "./wikitext.mjs";

/** @param {string} value */
function identity(value) {
  return plainWikitext(value).normalize("NFKC").trim().toLowerCase();
}

/** Prefer a unique structured quest/mission with corroborated identity and rewards.
 * Schedule overlap scopes the identity; reward dates need not coincide.
 * @param {Record<string, any>} fandom
 * @param {Record<string, any>} atlas
 * @param {ReturnType<typeof import("./fandom-campaign-adapter.mjs").questNameEvidence>} evidence
 */
export function preferAtlasQuestRewards(fandom, atlas, evidence = []) {
  const questTypes = new Set(["QUEST_CLEAR", "CHALLENGE_QUEST"]);
  const missionTypes = new Set(["LIMITED_MISSION", "MASTER_MISSION"]);
  const events = new Map(
    [...fandom.events, ...atlas.events].map((event) => [
      event.sourceKey,
      event,
    ]),
  );
  /** @param {Record<string, any>} source @param {Record<string, any>} reward @param {typeof evidence} aliases */
  const eligibility = (source, reward, aliases) => {
    const condition = aliases.reduce(
      (value, alias) =>
        value.replaceAll(identity(alias.japanese), identity(alias.english)),
      identity(reward.eligibility ?? ""),
    );
    if (questTypes.has(source.type)) {
      for (const alias of aliases) {
        const name = identity(alias.english);
        // Wiki quest rows can contain just the title; Atlas adds "Clear ...".
        // Only these exact forms are equivalent. Preserve additional conditions.
        if (
          condition === name ||
          condition === `clear ${name}` ||
          condition === `clear ${name}.`
        )
          return `clear ${name}`;
      }
    }
    return condition;
  };
  const signature = (
    /** @type {Record<string, any>} */ source,
    /** @type {typeof evidence} */ aliases,
  ) =>
    JSON.stringify(
      source.rewards
        .map((/** @type {Record<string, any>} */ reward) => [
          reward.itemType,
          reward.amount,
          reward.defaultIncluded,
          reward.nature,
          reward.storyWarId ?? null,
          reward.storyReleaseAt
            ? new Date(reward.storyReleaseAt).toISOString()
            : null,
          eligibility(source, reward, aliases),
        ])
        .sort(),
    );
  const proposals = new Map();
  for (const source of fandom.rewardSources) {
    if (
      (source.status && source.status !== "PROJECTED") ||
      source.rewards.some(
        (/** @type {Record<string, any>} */ reward) => reward.reviewedAt,
      )
    )
      continue;
    const quest = questTypes.has(source.type);
    if (!quest && !missionTypes.has(source.type)) continue;
    const separator = source.name.indexOf(": ");
    const name = identity(
      separator < 0 ? source.name : source.name.slice(separator + 2),
    );
    const aliases = quest
      ? evidence.filter(
          (row) =>
            row.evidenceSourceKey === source.evidenceSourceKey &&
            identity(row.english) === name,
        )
      : [];
    const names = new Set([
      name,
      ...aliases.map((row) => identity(row.japanese)),
    ]);
    const event = events.get(
      source.eventSourceKey ?? source.externalEventSourceKey,
    );
    if (!event) continue;
    const matches = atlas.rewardSources.filter(
      (/** @type {Record<string, any>} */ other) => {
        if (
          !(quest ? questTypes : missionTypes).has(other.type) ||
          !names.has(identity(other.name))
        )
          return false;
        const otherEvent = events.get(other.eventSourceKey);
        return (
          otherEvent &&
          (event.sourceKey === otherEvent.sourceKey ||
            (quest && aliases.length > 0)) &&
          Date.parse(event.startsAt) <= Date.parse(otherEvent.endsAt) &&
          Date.parse(otherEvent.startsAt) <= Date.parse(event.endsAt) &&
          signature(source, aliases) === signature(other, aliases)
        );
      },
    );
    if (matches.length === 1)
      proposals.set(source.sourceKey, matches[0].sourceKey);
  }
  const targets = [...proposals.values()];
  return {
    ...fandom,
    rewardSources: fandom.rewardSources.filter(
      (/** @type {Record<string, any>} */ source) => {
        const target = proposals.get(source.sourceKey);
        return !target || targets.filter((key) => key === target).length !== 1;
      },
    ),
  };
}
