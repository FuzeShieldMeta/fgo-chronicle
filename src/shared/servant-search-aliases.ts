/** Search only: these aliases never rename imported servants. */
export const servantSearchAliases: {
  families: readonly { name: string; aliases: readonly string[] }[];
  servants: Readonly<Record<number, readonly string[]>>;
} = {
  // A name phrase applies to every variant containing that phrase.
  // Use whole names for aliases that should not apply to a broader family.
  families: [
    { name: "Altria", aliases: ["Artoria", "Arturia", "Arthuria"] },
    { name: "Elisabeth", aliases: ["Elizabeth"] },
    { name: "Heracles", aliases: ["Hercules"] },
    { name: "Iskandar", aliases: ["Iskander"] },
    { name: "Enkidu", aliases: ["Enk"] },
    { name: "Ozymandias", aliases: ["Ozy"] },
    { name: "Gilgamesh", aliases: ["Gil"] },
    { name: "Scáthach", aliases: ["Shishou"] },
    { name: "Cú Chulainn", aliases: ["Cuchulainn"] },
    { name: "Xuanzang Sanzang", aliases: ["Sanzou", "Sanzo"] },
    { name: "Tam Lin Gawain", aliases: ["Barghest", "Fairy Knight Gawain"] },
    {
      name: "Tam Lin Tristan",
      aliases: ["Baobhan Sith", "Fairy Knight Tristan"],
    },
    {
      name: "Tam Lin Lancelot",
      aliases: ["Melusine", "Fairy Knight Lancelot"],
    },
    { name: "Altria Caster", aliases: ["Castoria"] },
    { name: "Katsushika Hokusai", aliases: ["Oei"] },
    { name: "Mysterious Heroine X", aliases: ["MHX"] },
    { name: "Mysterious Heroine X (Alter)", aliases: ["MHXA", "MHX Alter"] },
    { name: "Mysterious Heroine XX", aliases: ["MHXX"] },
    { name: "Mysterious Heroine XX (Alter)", aliases: ["MHXXA"] },
  ],
  // For a variant-specific nickname, add its imported Servant.id here:
  // <id>: ["nickname", "another nickname"].
  servants: {},
};
