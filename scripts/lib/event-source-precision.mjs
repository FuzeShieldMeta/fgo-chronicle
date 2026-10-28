/** Precision is source metadata, not a change to projected schedule dates.
 * @param {Record<string, any>} candidate
 * @param {Record<string, any>} existing
 */
export function eventSourcePrecisionChanged(candidate, existing) {
  return (
    (candidate.sourceStartsAtPrecision ?? null) !==
      (existing.sourceStartsAtPrecision ?? null) ||
    (candidate.sourceEndsAtPrecision ?? null) !==
      (existing.sourceEndsAtPrecision ?? null)
  );
}

/** Called only for otherwise unchanged projected events under the import lock.
 * A timestamp/source change since planning invalidates the precision update.
 * @param {Record<string, any>} transaction
 * @param {Record<string, any>} candidate
 * @param {Record<string, any> | undefined} existing
 */
export async function saveEventSourcePrecision(
  transaction,
  candidate,
  existing,
) {
  if (!existing)
    throw new Error("Event source changed during precision reconciliation.");
  const result = await transaction.event.updateMany({
    where: {
      sourceKey: candidate.sourceKey,
      status: "PROJECTED",
      sourceRegion: candidate.sourceRegion,
      sourceUrl: candidate.sourceUrl,
      sourceContentHash: existing.sourceContentHash ?? null,
      sourceStartsAtPrecision: existing.sourceStartsAtPrecision ?? null,
      sourceEndsAtPrecision: existing.sourceEndsAtPrecision ?? null,
      sourceStartsAt: candidate.sourceStartsAt
        ? new Date(candidate.sourceStartsAt)
        : null,
      sourceEndsAt: candidate.sourceEndsAt
        ? new Date(candidate.sourceEndsAt)
        : null,
    },
    data: {
      sourceStartsAtPrecision: candidate.sourceStartsAtPrecision ?? null,
      sourceEndsAtPrecision: candidate.sourceEndsAtPrecision ?? null,
      lastSyncedAt: candidate.lastSyncedAt
        ? new Date(candidate.lastSyncedAt)
        : null,
      sourceContentHash: candidate.sourceContentHash,
    },
  });
  if (result.count !== 1)
    throw new Error("Event source changed during precision reconciliation.");
}
