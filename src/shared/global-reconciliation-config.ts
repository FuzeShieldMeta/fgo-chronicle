export const MILLISECONDS_PER_DAY = 86_400_000;

// Shared limits for the curator UI and Global source collector. No server secrets.
export const GLOBAL_SOURCE_LIMITS = {
  defaultRangeDays: 35,
  maxRangeDays: 90,
  pageSize: 25,
  maxPage: 10_000,
  maxBatchRecords: 1_000,
  maxSnapshotBytes: 64 * 1_024,
  minPublicationReasonLength: 3,
  maxPublicationReasonLength: 1_000,
  transactionMaxWaitMs: 5_000,
  transactionTimeoutMs: 15_000,
} as const;
