export const standardSummonRates = [
  {
    id: "SOLO_SSR",
    label: "Solo SSR · 0.8%",
    rate: 0.008,
    guaranteedEligible: true,
  },
  {
    id: "SOLO_SR",
    label: "Solo SR · 2.1%",
    rate: 0.021,
    guaranteedEligible: false,
  },
  {
    id: "TWO_SHARED_SR",
    label: "Two shared SRs · 1.4%",
    rate: 0.014,
    guaranteedEligible: false,
  },
  {
    id: "THREE_SHARED_SR",
    label: "Three shared SRs · 0.8%",
    rate: 0.008,
    guaranteedEligible: false,
  },
  {
    id: "SOLO_R",
    label: "Solo R · 4%",
    rate: 0.04,
    guaranteedEligible: false,
  },
] as const;

export type StandardSummonRateId = (typeof standardSummonRates)[number]["id"];

export const standardSummonRateEvidenceUrl =
  "https://fategrandorder.fandom.com/wiki/Summoning";

export type AutomaticSummonRate = {
  label: string;
  rate: number;
  guaranteedEligible: boolean;
};

function rateLabel(label: string, rate: number) {
  const percentage = Number((rate * 100).toFixed(2));
  return `${label} · ${percentage}%`;
}

export function resolveAutomaticSummonRate({
  rarity,
  soloRateUp,
  sharedCount,
}: {
  rarity: number | null | undefined;
  soloRateUp: boolean;
  sharedCount: number;
}): AutomaticSummonRate | null {
  const count = soloRateUp ? 1 : Math.max(2, Math.floor(sharedCount));

  if (rarity === 5) {
    const rate = 0.008 / count;
    return {
      label: rateLabel(count === 1 ? "Solo SSR" : "Shared SSR", rate),
      rate,
      guaranteedEligible: count === 1,
    };
  }

  if (rarity === 4) {
    if (count === 1) return standardSummonRates[1];
    if (count === 2) return standardSummonRates[2];
    if (count === 3) return standardSummonRates[3];
    return null;
  }

  if (rarity === 3) {
    const rate = 0.04 / count;
    return {
      label: rateLabel(count === 1 ? "Solo R" : "Shared R", rate),
      rate,
      guaranteedEligible: false,
    };
  }

  return null;
}
