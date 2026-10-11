import type { MissionEvidence } from "./global-mission-evidence";

type ImportedReward = {
  id: string;
  sourceKey: string;
  itemType: string;
  amount: number;
  eligibility: string | null;
  protectedDate: boolean;
  sourceType: string;
};

// Recheck the locked imported records. A source revision or changed mission
// label invalidates the whole proof; curator-owned dates are simply preserved.
export function officialMissionDates(
  proof: { missions: readonly MissionEvidence[] },
  rewards: readonly ImportedReward[],
) {
  const dates = new Map<string, Date>();
  for (const mission of proof.missions) {
    for (const evidence of mission.rewards) {
      const matches = rewards.filter(
        (row) => row.sourceKey === evidence.sourceKey,
      );
      const row = matches[0];
      if (
        matches.length !== 1 ||
        !row ||
        !["MASTER_MISSION", "LIMITED_MISSION"].includes(row.sourceType) ||
        row.itemType !== evidence.itemType ||
        row.amount !== evidence.amount ||
        row.eligibility !== evidence.eligibility ||
        dates.has(row.id)
      )
        throw new Error("The imported chapter missions changed.");
      if (!row.protectedDate)
        dates.set(row.id, new Date(mission.official.endsAt));
    }
  }
  return dates;
}
