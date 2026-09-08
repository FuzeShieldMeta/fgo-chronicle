import { createHash } from "node:crypto";

import { reconcileProjectedJpEvents } from "./jp-event-reconciler.mjs";
import { buildProjectedEventDataset } from "./jp-event-sync.mjs";
import {
  loadJpEventSource,
  loadJpWarSource,
  parseAndValidateAtlasSource,
  parseAndValidateAtlasWarSource,
  parseIntegerSetting,
} from "./jp-event-source.mjs";

export const JP_EVENT_SYNC_SOURCE = "ATLAS_JP_EVENT_EXPORT";

/** @param {unknown} error */
function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

/**
 * @param {Record<string, any>} db
 * @param {string} syncRunId
 * @param {unknown} error
 */
async function markSyncRunFailed(db, syncRunId, error) {
  await db.syncRun.update({
    where: { id: syncRunId },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      errorMessage: errorMessage(error),
    },
  });
}

/**
 * @param {Record<string, any>} db
 * @param {{dryRun: boolean, asOf: Date, sourceFile: string | null, warSourceFile?: string | null}} options
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchFn?: (url: string, init: Record<string, any>) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>,
 *   readFileFn?: (path: string, encoding: "utf8") => Promise<string>,
 *   delayFn?: (milliseconds: number) => Promise<void>,
 *   timeoutSignal?: () => AbortSignal | undefined,
 *   sourceBody?: string,
 *   warSourceBody?: string,
 *   now?: () => Date,
 *   reconcileFn?: typeof reconcileProjectedJpEvents
 * }} [dependencies]
 */
export async function runJpEventSync(db, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  let syncRunId = null;

  if (!options.dryRun) {
    const syncRun = await db.syncRun.create({
      data: {
        source: JP_EVENT_SYNC_SOURCE,
        status: "RUNNING",
        dryRun: false,
      },
    });
    syncRunId = syncRun.id;
  }

  try {
    const minimumRecords = parseIntegerSetting(
      env.JP_EVENT_SYNC_MIN_EXPORT_RECORDS,
      { name: "JP_EVENT_SYNC_MIN_EXPORT_RECORDS", defaultValue: 1_000 },
    );
    const maxUpdates = parseIntegerSetting(env.JP_EVENT_SYNC_MAX_UPDATES, {
      name: "JP_EVENT_SYNC_MAX_UPDATES",
      defaultValue: 25,
      allowZero: true,
    });
    const maxRewardChanges = parseIntegerSetting(
      env.JP_EVENT_SYNC_MAX_REWARD_CHANGES,
      {
        name: "JP_EVENT_SYNC_MAX_REWARD_CHANGES",
        defaultValue: 250,
        allowZero: true,
      },
    );
    const minimumWarRecords = parseIntegerSetting(
      env.JP_WAR_SYNC_MIN_EXPORT_RECORDS,
      { name: "JP_WAR_SYNC_MIN_EXPORT_RECORDS", defaultValue: 200 },
    );
    const body =
      dependencies.sourceBody ??
      (await loadJpEventSource(options, {
        env,
        fetchFn: dependencies.fetchFn,
        readFileFn: dependencies.readFileFn,
        delayFn: dependencies.delayFn,
        timeoutSignal: dependencies.timeoutSignal,
      }));
    const contentHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const warBody =
      dependencies.warSourceBody ??
      (await loadJpWarSource(options, {
        env,
        fetchFn: dependencies.fetchFn,
        readFileFn: dependencies.readFileFn,
        delayFn: dependencies.delayFn,
        timeoutSignal: dependencies.timeoutSignal,
      }));
    const warContentHash = `sha256:${createHash("sha256").update(warBody).digest("hex")}`;
    const rawEvents = parseAndValidateAtlasSource(body, minimumRecords);
    const rawWars = parseAndValidateAtlasWarSource(warBody, minimumWarRecords);
    const retrievedAt = now().toISOString();
    const dataset = buildProjectedEventDataset(rawEvents, {
      asOf: options.asOf,
      retrievedAt,
      contentHash,
      warContentHash,
      rawWars,
    });
    if (dataset.events.length === 0) {
      throw new Error("The rolling JP window contains no supported events.");
    }

    return await (dependencies.reconcileFn ?? reconcileProjectedJpEvents)(
      db,
      dataset,
      {
        asOf: options.asOf,
        dryRun: options.dryRun,
        maxUpdates,
        maxRewardChanges,
        syncRunId,
      },
    );
  } catch (error) {
    const failureWasRecorded = Boolean(
      error &&
      typeof error === "object" &&
      /** @type {{syncRunFailureRecorded?: boolean}} */ (error)
        .syncRunFailureRecorded,
    );
    if (syncRunId && !failureWasRecorded) {
      try {
        await markSyncRunFailed(db, syncRunId, error);
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          "JP event synchronisation failed and its failure could not be recorded.",
        );
      }
    }
    throw error;
  }
}
