export const plannerChangesLimits = {
  rewardLookupBatchSize: 100,
  maximumRewardIdLength: 200,
  servantLookupBatchSize: 100,
  maximumServantId: 2_147_483_647, // Servant.id is a PostgreSQL integer.
} as const;
