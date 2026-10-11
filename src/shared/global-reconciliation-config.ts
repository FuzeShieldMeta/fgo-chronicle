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
  transactionAttempts: 3,
  transactionRetryDelayMs: 25,
} as const;

export const GLOBAL_ANNOUNCEMENT_LIMITS = {
  maxBodyBytes: 2 * 1_024 * 1_024,
  maxTreeNodes: 100_000,
  maxPeriodsPerArticle: 100,
  contextLines: 4,
  maxContextCharacters: 1_200,
  maxTitleCharacters: 500,
  maxArticlePathCharacters: 160,
  parserRevision: 4,
  fetchTimeoutMs: 15_000,
  collectionTimeoutMs: 45_000,
  maxArticles: 30,
  maxIndexPages: 3,
} as const;

export const GLOBAL_ANNOUNCEMENT_MATCHING = {
  windowDays: [30, 60, 90],
  revision: 4,
  minNameTokens: 2,
  minNameCharacters: 12,
  minServantNameCharacters: 3,
} as const;

// Opt-in archive collection; daily cron retains the smaller announcement limits.
export const GLOBAL_ANNOUNCEMENT_BACKFILL_LIMITS = {
  maxDays: 90,
  maxArticles: 200,
  maxIndexPages: 12,
  collectionTimeoutMs: 180_000,
} as const;

export const GLOBAL_CAMPAIGN_IDENTITY_LIMITS = {
  maxPages: 50,
  maxBodyBytes: 8 * 1_024 * 1_024,
  fetchTimeoutMs: 15_000,
  lookbackDays: 60,
  maxOfficialArticles: 12,
  collectionTimeoutMs: 45_000,
  jstOffsetMinutes: 9 * 60,
  maxMissionTableColumns: 12,
  minMissionSubtitleCharacters: 12,
} as const;

export const GLOBAL_EXPORT_LIMITS = {
  collectionTimeoutMs: 60_000,
  maxBodyBytes: 64 * 1_024 * 1_024,
} as const;

export const IMPORT_EXECUTION_LIMITS = {
  heartbeatMs: 15_000,
  assessmentTransactionTimeoutMs: 30_000,
  familyTransactionTimeoutMs: 60_000,
} as const;
