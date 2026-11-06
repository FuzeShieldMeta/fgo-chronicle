const labels = new Map([
  ["saber", "Saber"],
  ["archer", "Archer"],
  ["lancer", "Lancer"],
  ["rider", "Rider"],
  ["caster", "Caster"],
  ["assassin", "Assassin"],
  ["berserker", "Berserker"],
  ["ruler", "Ruler"],
  ["avenger", "Avenger"],
  ["mooncancer", "Moon Cancer"],
  ["alterego", "Alter Ego"],
  ["foreigner", "Foreigner"],
  ["pretender", "Pretender"],
  ["shielder", "Shielder"],
  ["beast", "Beast"],
]);

/** Compare Atlas keys with existing display labels without treating EXTRA as a class. @param {string} name */
export function servantClassKey(name) {
  return name.replace(/[\s_-]/gu, "").toLowerCase();
}

/** Unknown future class keys remain as supplied by Atlas. @param {string} name */
export function servantClassLabel(name) {
  return labels.get(servantClassKey(name)) ?? name;
}
