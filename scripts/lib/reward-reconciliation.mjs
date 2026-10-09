class ReconciliationLimitError extends Error {
  /** @param {"EVENT_UPDATES" | "REWARD_CHANGES"} kind @param {number} proposed @param {number} limit */
  constructor(kind, proposed, limit) {
    super(limitMessage(kind, proposed, limit));
    this.kind = kind;
    this.proposed = proposed;
    this.limit = limit;
  }
}

/** @param {unknown} error */
export function primaryImportFailure(error) {
  const seen = new Set();
  while (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    !seen.has(error)
  ) {
    seen.add(error);
    error = error.errors[0];
  }
  return error;
}

/** @param {"EVENT_UPDATES" | "REWARD_CHANGES"} kind @param {number} proposed @param {number} limit */
function limitMessage(kind, proposed, limit) {
  const label = kind === "REWARD_CHANGES" ? "reward changes" : "updates";
  return `The sync proposed ${proposed} ${label}. The limit is ${limit}. Inspect a dry run before you raise the limit.`;
}

/** @param {unknown} error */
export function reconciliationLimitDetails(error) {
  if (
    !(error instanceof ReconciliationLimitError) ||
    !["EVENT_UPDATES", "REWARD_CHANGES"].includes(error.kind) ||
    !Number.isSafeInteger(error.proposed) ||
    error.proposed < 0 ||
    !Number.isSafeInteger(error.limit) ||
    error.limit < 0
  )
    return null;
  return {
    category:
      error.kind === "REWARD_CHANGES"
        ? "REWARD_CHANGE_LIMIT_EXCEEDED"
        : "EVENT_UPDATE_LIMIT_EXCEEDED",
    message: limitMessage(error.kind, error.proposed, error.limit),
  };
}

/** @param {Record<string, any>} source */
export function isProtectedRewardSource(source) {
  return source.status === "CURATED" || source.status === "OFFICIAL";
}

/** @param {Record<string, any> | undefined} existing @param {Record<string, any>} desired */
export function rewardDateBasisChanged(existing, desired) {
  return (
    (existing?.dateBasis ?? "UNKNOWN") !== (desired.dateBasis ?? "UNKNOWN")
  );
}

/** @param {Record<string, any>} reward */
function rewardSignature(reward) {
  return JSON.stringify([
    reward.itemType,
    reward.amount,
    reward.expectedAt ? new Date(reward.expectedAt).toISOString() : null,
    reward.nature,
    reward.eligibility ?? null,
    reward.defaultIncluded,
    reward.storyWarId ?? null,
    reward.storyReleaseAt
      ? new Date(reward.storyReleaseAt).toISOString()
      : null,
  ]);
}

/** @param {Record<string, any>} existing @param {Record<string, any>} desired */
export function rewardContentChanged(existing, desired) {
  return rewardSignature(existing) !== rewardSignature(desired);
}

/**
 * Count actual changes to existing events, including newly discovered rewards
 * and definitions removed with an obsolete source. Initial event imports are
 * reported separately. Verification timestamps do not count as content edits.
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 * @param {{insertMissingOnly?: boolean, obsoleteSourceIds?: string[]}} options
 */
export function eventRewardChangeBreakdown(
  event,
  desiredSources,
  options = {},
) {
  const changes = {
    dateBasisOnly: 0,
    rewardUpdates: 0,
    newRewards: 0,
    sourceUpdates: 0,
    removedRecords: 0,
  };
  const existingSources = new Map(
    (event.rewardSources ?? []).map(
      (/** @type {Record<string, any>} */ source) => [source.sourceKey, source],
    ),
  );
  const obsolete = new Set(options.obsoleteSourceIds ?? []);
  changes.removedRecords = (event.rewardSources ?? []).reduce(
    (/** @type {number} */ total, /** @type {Record<string, any>} */ source) =>
      total +
      (obsolete.has(source.id) ? Math.max(1, source.rewards.length) : 0),
    0,
  );
  for (const source of desiredSources) {
    const existing = existingSources.get(source.sourceKey);
    if (existing && isProtectedRewardSource(existing)) continue;
    if (!existing) {
      changes.newRewards += source.rewards.length;
      continue;
    }
    if (
      !options.insertMissingOnly &&
      ["name", "type", "status", "evidenceUrl"].some(
        (key) => source[key] !== existing[key],
      )
    )
      changes.sourceUpdates += 1;
    const rewards = new Map(
      existing.rewards.map((/** @type {Record<string, any>} */ reward) => [
        reward.sourceKey,
        reward,
      ]),
    );
    for (const reward of source.rewards) {
      const previous = rewards.get(reward.sourceKey);
      if (!previous) changes.newRewards += 1;
      else if (
        !options.insertMissingOnly &&
        !previous.reviewedAt &&
        rewardContentChanged(previous, reward)
      )
        changes.rewardUpdates += 1;
      else if (rewardDateBasisChanged(previous, reward))
        changes.dateBasisOnly += 1;
    }
  }
  return changes;
}

/**
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 * @param {{insertMissingOnly?: boolean, obsoleteSourceIds?: string[]}} options
 */
export function countEventRewardChanges(event, desiredSources, options = {}) {
  return Object.values(
    eventRewardChangeBreakdown(event, desiredSources, options),
  ).reduce((total, count) => total + count, 0);
}

/**
 * @param {{eventChanges: number, rewardChanges: number, maxUpdates: number, maxRewardChanges: number, dryRun?: boolean}} options
 */
export function checkReconciliationLimits(options) {
  for (const [name, value] of [
    ["eventChanges", options.eventChanges],
    ["rewardChanges", options.rewardChanges],
    ["maxUpdates", options.maxUpdates],
    ["maxRewardChanges", options.maxRewardChanges],
  ]) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error(`${name} must be a non-negative integer.`);
  }
  const updateLimitExceeded = options.eventChanges > options.maxUpdates;
  const rewardChangeLimitExceeded =
    options.rewardChanges > options.maxRewardChanges;
  if (!options.dryRun && updateLimitExceeded)
    throw new ReconciliationLimitError(
      "EVENT_UPDATES",
      options.eventChanges,
      options.maxUpdates,
    );
  if (!options.dryRun && rewardChangeLimitExceeded)
    throw new ReconciliationLimitError(
      "REWARD_CHANGES",
      options.rewardChanges,
      options.maxRewardChanges,
    );
  return {
    updateLimit: options.maxUpdates,
    updateLimitExceeded,
    rewardChanges: options.rewardChanges,
    rewardChangeLimit: options.maxRewardChanges,
    rewardChangeLimitExceeded,
  };
}
