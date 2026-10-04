export const eventCurationFields = [
  "name",
  "startsAt",
  "endsAt",
  "hidden",
  "shiftRewardDates",
] as const;
export const rewardCurationFields = [
  "itemType",
  "amount",
  "expectedAt",
  "nature",
  "eligibility",
  "defaultIncluded",
] as const;

export function ownsField(curation: { ownedFields?: string[] }, field: string) {
  // Old snapshots own every field until the migration records that ownership.
  return (
    curation.ownedFields === undefined || curation.ownedFields.includes(field)
  );
}
