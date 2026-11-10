import {
  SERVANT_RARITY_BY_LABEL,
  STANDARD_BANNER_ROSTER_LIMITS as LIMITS,
} from "~/shared/global-reconciliation-config";

export function previewStandardBannerRoster<T extends { rarity: number }>(
  members: readonly T[],
) {
  const counts = new Map<number, number>();
  for (const member of members)
    counts.set(member.rarity, (counts.get(member.rarity) ?? 0) + 1);
  const supported = [
    SERVANT_RARITY_BY_LABEL.ssr!,
    SERVANT_RARITY_BY_LABEL.sr!,
    SERVANT_RARITY_BY_LABEL.r!,
  ];
  const issues =
    (counts.get(SERVANT_RARITY_BY_LABEL.ssr!) ?? 0) !==
      LIMITS.requiredSsrCount ||
    (counts.get(SERVANT_RARITY_BY_LABEL.sr!) ?? 0) > LIMITS.maxSrCount ||
    (counts.get(SERVANT_RARITY_BY_LABEL.r!) ?? 0) > LIMITS.maxRCount ||
    members.some((member) => !supported.includes(member.rarity))
      ? ["ROSTER_RATE_FORMAT_UNSUPPORTED"]
      : [];
  return {
    issues,
    rateRule: "STANDARD_RATE_UP" as const,
    featured: members.map((member) => ({
      ...member,
      soloRateUp: counts.get(member.rarity) === 1,
    })),
  };
}
