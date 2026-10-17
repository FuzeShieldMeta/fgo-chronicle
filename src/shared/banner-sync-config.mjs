export const BANNER_SYNC_LIMITS = {
  fetchTimeoutMs: 15_000,
  maxCsvBytes: 8 * 1_024 * 1_024,
  maxRowsPerSheet: 10_000,
  maxBanners: 1_000,
  maxFeaturedServants: 600,
  maxFeaturedMemberships: 20_000,
  maxTotalLineups: 1_000,
  maxLineupsPerBanner: 50,
  maxTextCharacters: 500,
};

export const BANNER_SPREADSHEET_SHEETS = [
  "Saber",
  "Archer",
  "Lancer",
  "Rider",
  "Caster",
  "Assassin",
  "Berserker",
  "EXTRA",
  "EXTRA I",
  "EXTRA II",
];
