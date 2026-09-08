export const ATLAS_TRACKED_REWARD_ITEMS = new Map([
  [2, "SAINT_QUARTZ"],
  [6, "SAINT_QUARTZ"],
  [11, "SAINT_QUARTZ_FRAGMENT"],
  [16, "SAINT_QUARTZ_FRAGMENT"],
  [4001, "SUMMON_TICKET"],
  [6999, "CRYSTALLIZED_LORE"],
  [7999, "HOLY_GRAIL"],
]);

export const ATLAS_TRACKED_REWARD_ITEM_IDS = new Set(
  ATLAS_TRACKED_REWARD_ITEMS.keys(),
);

export const ATLAS_MANA_PRISM_ITEM_ID = 3;

export const ATLAS_PERMANENT_QUEST_WARS = Object.freeze({
  RANK_UP: Object.freeze({
    id: 1001,
    originalName: "強化クエスト",
    displayName: "Rank Up Quest hub",
  }),
  INTERLUDE: Object.freeze({
    id: 1003,
    originalName: "幕間の物語",
    displayName: "Interlude hub",
  }),
});

export const ATLAS_PERMANENT_QUEST_WAR_IDS = new Set(
  Object.values(ATLAS_PERMANENT_QUEST_WARS).map(({ id }) => id),
);

/**
 * Resolve a stable Atlas quest hub and verify its identity before use. The ID
 * is an Atlas data contract, not an event-specific exception.
 * @param {Array<Record<string, any>>} wars
 * @param {keyof typeof ATLAS_PERMANENT_QUEST_WARS} kind
 */
export function findAtlasPermanentQuestWar(wars, kind) {
  const contract = ATLAS_PERMANENT_QUEST_WARS[kind];
  const war = wars.find(({ id }) => id === contract.id) ?? null;
  if (!war) {
    return {
      war: null,
      issue: `Atlas did not provide its ${contract.displayName} (war ${contract.id}). Rewards require review.`,
    };
  }

  const names = [war.originalName, war.name].filter(
    (name) => typeof name === "string" && name.trim(),
  );
  if (!names.includes(contract.originalName)) {
    return {
      war: null,
      issue: `Atlas war ${contract.id} no longer identifies the ${contract.displayName}. Rewards require review.`,
    };
  }

  return { war, issue: null };
}
