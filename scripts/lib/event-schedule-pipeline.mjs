import {
  buildStoryCatalogue,
  reconcileStoryCatalogue,
} from "./story-catalogue.mjs";
import { parseEventDataset } from "./event-dataset.mjs";
import { buildProjectedEventDataset } from "./jp-event-sync.mjs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  safeSyncFailure,
  summariseEventSchedule,
} from "./event-schedule-monitoring.mjs";

import { buildFandomCoverage } from "./fandom-coverage.mjs";
import { reconcileProjectedFandomEvents } from "./fandom-event-reconciler.mjs";
import { runJpEventSync } from "./jp-event-sync-runner.mjs";
import { reconcileProjectedMasterMissions } from "./jp-master-mission-reconciler.mjs";
import { buildProjectedMasterMissionDataset } from "./jp-master-mission-sync.mjs";
import { preferAtlasMasterMissions } from "./master-mission-precedence.mjs";
import { preferAtlasPanelMissions } from "./panel-mission-precedence.mjs";
import { preferAtlasQuestRewards } from "./quest-reward-precedence.mjs";
import {
  loadJpEventSource,
  loadJpMasterMissionSource,
  loadJpWarSource,
  parseAndValidateAtlasMasterMissionSource,
  parseAndValidateAtlasSource,
  parseAndValidateAtlasWarSource,
  parseIntegerSetting,
} from "./jp-event-source.mjs";

const TEMPORARY_FILE_SUFFIX = ".tmp";

/**
 * Replace a review dataset only after the complete file has been written.
 * @param {string} outputPath
 * @param {Record<string, any>} dataset
 */
export async function writeDatasetAtomically(outputPath, dataset) {
  const resolvedPath = path.resolve(outputPath);
  const temporaryPath = `${resolvedPath}.${process.pid}.${Date.now()}${TEMPORARY_FILE_SUFFIX}`;
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(dataset, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, resolvedPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Validate every source dataset before publishing any source.
 * @param {Record<string, any>} db
 * @param {{dryRun: boolean, asOf: Date, sourceFile: string | null, warSourceFile?: string | null, masterMissionSourceFile?: string | null, outputPath: string | null}} options
 * @param {{
 *   progress?: import("../../src/server/services/import-progress").ImportProgress,
 *   env?: Record<string, string | undefined>,
 *   loadSourceFn?: (options: Record<string, any>, dependencies?: Record<string, any>) => Promise<string>,
 *   loadWarSourceFn?: (options: Record<string, any>, dependencies?: Record<string, any>) => Promise<string>,
 *   loadMasterMissionSourceFn?: (options: Record<string, any>, dependencies?: Record<string, any>) => Promise<string>,
 *   runAtlasSyncFn?: (db: Record<string, any>, options: Record<string, any>, dependencies?: Record<string, any>) => Promise<Record<string, any>>,
 *   parseAtlasFn?: (body: string, minimumRecords: number) => Array<Record<string, any>>,
 *   parseAtlasWarFn?: (body: string, minimumRecords: number) => Array<Record<string, any>>,
 *   parseAtlasMasterMissionFn?: (body: string, minimumRecords: number) => Array<Record<string, any>>,
 *   buildMasterMissionsFn?: (missions: any[], options: Record<string, any>) => Record<string, any>,
 *   reconcileMasterMissionsFn?: (db: Record<string, any>, dataset: Record<string, any>, options: Record<string, any>) => Promise<Record<string, any>>,
 *   applyMasterMissionPrecedenceFn?: (fandom: Record<string, any>, missions: Record<string, any>, events: Array<Record<string, any>>) => Record<string, any>,
 *   buildCoverageFn?: (events: Parameters<typeof buildFandomCoverage>[0], options: Parameters<typeof buildFandomCoverage>[1]) => Promise<{dataset: Record<string, any>, questEvidence?: ReturnType<typeof import("./fandom-campaign-adapter.mjs").questNameEvidence>, supersededEvents?: Array<{sourceEventKey: string, targetEventKey: string, matchMethod: string | null, sourceName: string, targetName: string}>, report: Record<string, any>}>,
 *   reconcileFandomFn?: (db: Record<string, any>, dataset: Record<string, any>, options: Record<string, any>) => Promise<Record<string, any>>,
 *   writeDatasetFn?: (outputPath: string, dataset: Record<string, any>) => Promise<void>,
 *   fetchFn?: (url: string, init: Record<string, any>) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>,
 *   readFileFn?: (path: string, encoding: "utf8") => Promise<string>,
 *   delayFn?: (milliseconds: number) => Promise<void>,
 *   timeoutSignal?: () => AbortSignal | undefined,
 * }} [dependencies]
 */
export async function runEventSchedulePipeline(db, options, dependencies = {}) {
  const progress = dependencies.progress;
  /** @template T @param {Parameters<NonNullable<typeof progress>["stage"]>[0]} name @param {() => Promise<T>} work */
  const stage = (name, work) =>
    progress ? progress.stage(name, work) : work();
  const startedAt = new Date();
  const env = dependencies.env ?? process.env;
  const masterMissionMaxUpdates = parseIntegerSetting(
    env.JP_MASTER_MISSION_SYNC_MAX_UPDATES,
    {
      name: "JP_MASTER_MISSION_SYNC_MAX_UPDATES",
      defaultValue: 25,
      allowZero: true,
    },
  );
  const masterMissionMaxAssociationUpdates = parseIntegerSetting(
    env.JP_MASTER_MISSION_SYNC_MAX_ASSOCIATION_UPDATES,
    {
      name: "JP_MASTER_MISSION_SYNC_MAX_ASSOCIATION_UPDATES",
      defaultValue: 50,
      allowZero: true,
    },
  );
  const fandomMaxUpdates = parseIntegerSetting(
    env.FANDOM_EVENT_SYNC_MAX_UPDATES,
    {
      name: "FANDOM_EVENT_SYNC_MAX_UPDATES",
      defaultValue: 25,
      allowZero: true,
    },
  );
  const transactionTimeout = parseIntegerSetting(
    env.EVENT_SCHEDULE_TRANSACTION_TIMEOUT_MS,
    {
      name: "EVENT_SCHEDULE_TRANSACTION_TIMEOUT_MS",
      defaultValue: 240_000,
    },
  );
  for (const name of [
    "JP_EVENT_SYNC_MAX_UPDATES",
    "JP_EVENT_SYNC_MAX_REWARD_CHANGES",
    "FANDOM_EVENT_SYNC_MAX_REWARD_CHANGES",
  ]) {
    parseIntegerSetting(env[name], {
      name,
      defaultValue: name.endsWith("REWARD_CHANGES") ? 250 : 25,
      allowZero: true,
    });
  }
  const loadSource = dependencies.loadSourceFn ?? loadJpEventSource;
  const atlasBody = await stage("atlas_events_download", () =>
    loadSource(options, {
      env,
      fetchFn: dependencies.fetchFn,
      readFileFn: dependencies.readFileFn,
      delayFn: dependencies.delayFn,
      timeoutSignal: dependencies.timeoutSignal,
    }),
  );
  const loadWarSource = dependencies.loadWarSourceFn ?? loadJpWarSource;
  const atlasWarBody = await stage("atlas_wars_download", () =>
    loadWarSource(options, {
      env,
      fetchFn: dependencies.fetchFn,
      readFileFn: dependencies.readFileFn,
      delayFn: dependencies.delayFn,
      timeoutSignal: dependencies.timeoutSignal,
    }),
  );
  const loadMasterMissionSource =
    dependencies.loadMasterMissionSourceFn ?? loadJpMasterMissionSource;
  const atlasMasterMissionBody = await stage("atlas_missions_download", () =>
    loadMasterMissionSource(options, {
      env,
      fetchFn: dependencies.fetchFn,
      readFileFn: dependencies.readFileFn,
      delayFn: dependencies.delayFn,
      timeoutSignal: dependencies.timeoutSignal,
    }),
  );
  const minimumRecords = parseIntegerSetting(
    env.JP_EVENT_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_EVENT_SYNC_MIN_EXPORT_RECORDS", defaultValue: 1_000 },
  );
  const atlasEvents = (
    dependencies.parseAtlasFn ?? parseAndValidateAtlasSource
  )(atlasBody, minimumRecords);
  const minimumWarRecords = parseIntegerSetting(
    env.JP_WAR_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_WAR_SYNC_MIN_EXPORT_RECORDS", defaultValue: 200 },
  );
  const atlasWars = (
    dependencies.parseAtlasWarFn ?? parseAndValidateAtlasWarSource
  )(atlasWarBody, minimumWarRecords);
  const minimumMasterMissionRecords = parseIntegerSetting(
    env.JP_MASTER_MISSION_SYNC_MIN_EXPORT_RECORDS,
    { name: "JP_MASTER_MISSION_SYNC_MIN_EXPORT_RECORDS", defaultValue: 50 },
  );
  const atlasMasterMissions = (
    dependencies.parseAtlasMasterMissionFn ??
    parseAndValidateAtlasMasterMissionSource
  )(atlasMasterMissionBody, minimumMasterMissionRecords);
  const storyCatalogue = buildStoryCatalogue(atlasWars);
  const warContentHash = `sha256:${createHash("sha256").update(atlasWarBody).digest("hex")}`;
  const masterMissionContentHash = `sha256:${createHash("sha256").update(atlasMasterMissionBody).digest("hex")}`;
  const retrievedAt = new Date().toISOString();
  const masterMissionDataset = (
    dependencies.buildMasterMissionsFn ?? buildProjectedMasterMissionDataset
  )(atlasMasterMissions, {
    asOf: options.asOf,
    retrievedAt,
    contentHash: masterMissionContentHash,
    rawWars: atlasWars,
  });
  const supportedAtlasEvents =
    /** @type {Parameters<typeof buildFandomCoverage>[0]} */ (atlasEvents);
  /** @type {NonNullable<typeof dependencies.buildCoverageFn>} */
  const buildCoverage = dependencies.buildCoverageFn ?? buildFandomCoverage;
  const coverage = await stage("fandom_download", () =>
    buildCoverage(supportedAtlasEvents, {
      asOf: options.asOf,
      rawWars: atlasWars,
      warContentHash,
      onProgress: (counts) =>
        progress?.event("fandom_download", "batch_completed", counts),
    }),
  );
  const atlasDataset = buildProjectedEventDataset(supportedAtlasEvents, {
    asOf: options.asOf,
    retrievedAt,
    contentHash: `sha256:${createHash("sha256").update(atlasBody).digest("hex")}`,
    rawWars: atlasWars,
    warContentHash,
  });
  const fandomPublicationDataset = (
    dependencies.applyMasterMissionPrecedenceFn ?? preferAtlasMasterMissions
  )(
    preferAtlasQuestRewards(
      preferAtlasPanelMissions(coverage.dataset, atlasDataset),
      atlasDataset,
      coverage.questEvidence,
    ),
    masterMissionDataset,
    supportedAtlasEvents,
  );
  parseEventDataset(masterMissionDataset);
  parseEventDataset(fandomPublicationDataset.dataset);
  parseEventDataset(atlasDataset);
  /** @param {Record<string, any>} publicationDb */
  const publish = async (publicationDb) => {
    const storyReport = await stage("story_publication", () =>
      reconcileStoryCatalogue(publicationDb, storyCatalogue, options),
    );
    const atlasReport = await stage("atlas_publication", () =>
      (dependencies.runAtlasSyncFn ?? runJpEventSync)(publicationDb, options, {
        env,
        sourceBody: atlasBody,
        warSourceBody: atlasWarBody,
      }),
    );
    const fandomPublication = await stage("fandom_publication", () =>
      (dependencies.reconcileFandomFn ?? reconcileProjectedFandomEvents)(
        publicationDb,
        fandomPublicationDataset.dataset,
        {
          asOf: options.asOf,
          dryRun: options.dryRun,
          maxUpdates: fandomMaxUpdates,
          maxRewardChanges: parseIntegerSetting(
            env.FANDOM_EVENT_SYNC_MAX_REWARD_CHANGES,
            {
              name: "FANDOM_EVENT_SYNC_MAX_REWARD_CHANGES",
              defaultValue: 250,
              allowZero: true,
            },
          ),
          supersededEvents: coverage.supersededEvents ?? [],
          externalEventSourceKeys:
            fandomPublicationDataset.externalEventSourceKeys ?? [],
        },
      ),
    );
    const masterMissionReport = await stage("mission_publication", () =>
      (
        dependencies.reconcileMasterMissionsFn ??
        reconcileProjectedMasterMissions
      )(publicationDb, masterMissionDataset, {
        dryRun: options.dryRun,
        maxUpdates: masterMissionMaxUpdates,
        maxAssociationUpdates: masterMissionMaxAssociationUpdates,
        ambiguousRewardSourceKeys:
          fandomPublicationDataset.ambiguousRewardSourceKeys ?? [],
        eventAssociations:
          fandomPublicationDataset.masterMissionAssociations ?? [],
      }),
    );

    return { atlasReport, fandomPublication, masterMissionReport, storyReport };
  };
  let publication;
  if (options.dryRun) {
    publication = await publish(db);
  } else {
    const syncRun = await db.syncRun.create({
      data: {
        source: "EVENT_SCHEDULE_PIPELINE",
        status: "RUNNING",
        dryRun: false,
        startedAt,
      },
    });
    try {
      publication = await db.$transaction(
        async (/** @type {Record<string, any>} */ transaction) => {
          const [lock] = await transaction.$queryRawUnsafe(
            "SELECT pg_try_advisory_xact_lock(734621908) AS acquired",
          );
          if (!lock?.acquired)
            throw new Error(
              "Another event schedule synchronisation is running.",
            );
          // Each reconciler joins this transaction instead of committing independently.
          const publicationDb = new Proxy(transaction, {
            get(target, property) {
              if (property === "$transaction")
                return async (
                  /** @type {(tx: Record<string, any>) => Promise<any>} */ callback,
                ) => callback(transaction);
              return Reflect.get(target, property);
            },
          });
          const result = await publish(publicationDb);
          await transaction.syncRun.update({
            where: { id: syncRun.id },
            data: {
              status: "SUCCEEDED",
              completedAt: new Date(),
              ...summariseEventSchedule({
                atlas: result.atlasReport,
                masterMissions: result.masterMissionReport,
                fandom: {
                  ...coverage.report,
                  ...fandomPublicationDataset.report,
                  publication: result.fandomPublication,
                },
              }).totals,
            },
          });
          return result;
        },
        { maxWait: 10_000, timeout: transactionTimeout },
      );
    } catch (error) {
      try {
        await db.syncRun.update({
          where: { id: syncRun.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errorMessage: safeSyncFailure(error),
          },
        });
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          "Event schedule synchronisation failed and its failure could not be recorded.",
        );
      }
      throw error;
    }
  }
  const { atlasReport, fandomPublication, masterMissionReport } = publication;

  if (!options.dryRun && options.outputPath) {
    await (dependencies.writeDatasetFn ?? writeDatasetAtomically)(
      options.outputPath,
      fandomPublicationDataset.dataset,
    );
  }

  return {
    stories: publication.storyReport,
    atlas: atlasReport,
    masterMissions: masterMissionReport,
    fandom: {
      ...coverage.report,
      ...fandomPublicationDataset.report,
      publication: fandomPublication,
    },
    coverageWritten: Boolean(!options.dryRun && options.outputPath),
  };
}
