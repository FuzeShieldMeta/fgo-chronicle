/** @param {Record<string, any>} source */
export function isProtectedRewardSource(source) {
  return source.status === "CURATED" || source.status === "OFFICIAL";
}

/** @param {Record<string, any> | undefined} existing @param {Record<string, any>} desired */
export function rewardDateBasisChanged(existing, desired) {
  return (existing?.dateBasis ?? "UNKNOWN") !== (desired.dateBasis ?? "UNKNOWN");
}

/** @param {Record<string, any>} reward */
function rewardSignature(reward) {
  return JSON.stringify([
    reward.itemType,
    reward.amount,
    reward.expectedAt ? new Date(reward.expectedAt).toISOString() : null,
    reward.dateBasis ?? "UNKNOWN",
    reward.nature,
    reward.eligibility ?? null,
    reward.defaultIncluded,
    reward.storyWarId ?? null,
    reward.storyReleaseAt
      ? new Date(reward.storyReleaseAt).toISOString()
      : null,
  ]);
}

/**
 * Count actual changes to existing events, including newly discovered rewards
 * and definitions removed with an obsolete source. Initial event imports are
 * reported separately. Verification timestamps do not count as content edits.
 * @param {Record<string, any>} event
 * @param {Array<Record<string, any>>} desiredSources
 * @param {{insertMissingOnly?: boolean, obsoleteSourceIds?: string[]}} options
 */
export function countEventRewardChanges(event, desiredSources, options = {}) {
  const existingSources = new Map(
    (event.rewardSources ?? []).map(
      (/** @type {Record<string, any>} */ source) => [source.sourceKey, source],
    ),
  );
  const obsolete = new Set(options.obsoleteSourceIds ?? []);
  let count = (event.rewardSources ?? []).reduce(
    (/** @type {number} */ total, /** @type {Record<string, any>} */ source) =>
      total +
      (obsolete.has(source.id) ? Math.max(1, source.rewards.length) : 0),
    0,
  );
  for (const source of desiredSources) {
    const existing = existingSources.get(source.sourceKey);
    if (existing && isProtectedRewardSource(existing)) continue;
    if (!existing) {
      count += source.rewards.length;
      continue;
    }
    if (
      !options.insertMissingOnly &&
      ["name", "type", "status", "evidenceUrl"].some(
        (key) => source[key] !== existing[key],
      )
    )
      count += 1;
    const rewards = new Map(
      existing.rewards.map((/** @type {Record<string, any>} */ reward) => [
        reward.sourceKey,
        reward,
      ]),
    );
    for (const reward of source.rewards) {
      const previous = rewards.get(reward.sourceKey);
      if (!previous) count += 1;
      else if (rewardDateBasisChanged(previous, reward)) count += 1;
      else if (
        !options.insertMissingOnly &&
        !previous.reviewedAt &&
        rewardSignature(previous) !== rewardSignature(reward)
      )
        count += 1;
    }
  }
  return count;
}

/**
 * @param {{eventChanges: number, rewardChanges: number, maxUpdates: number, maxRewardChanges: number, dryRun?: boolean}} options
 */
export function checkReconciliationLimits(options) {
  for (const [name, value] of [
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
    throw new Error(
      `The sync proposed ${options.eventChanges} updates. The limit is ${options.maxUpdates}. Inspect a dry run before you raise the limit.`,
    );
  if (!options.dryRun && rewardChangeLimitExceeded)
    throw new Error(
      `The sync proposed ${options.rewardChanges} reward changes. The limit is ${options.maxRewardChanges}. Inspect a dry run before you raise the limit.`,
    );
  return {
    updateLimit: options.maxUpdates,
    updateLimitExceeded,
    rewardChanges: options.rewardChanges,
    rewardChangeLimit: options.maxRewardChanges,
    rewardChangeLimitExceeded,
  };
}
