import type { PrismaClient } from "../../../generated/prisma";
import { runEventSchedulePipeline } from "../../../scripts/lib/event-schedule-pipeline.mjs";
import { safeSyncFailure } from "../../../scripts/lib/event-schedule-monitoring.mjs";
import {
  requireSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { collectGlobalSourcesWithAuthority } from "./global-source-cron";
import { createImportProgress, type ImportProgress } from "./import-progress";
import { validateAnnouncementBackfillDays } from "./global-announcement-source";
import { syncServantCatalogue } from "./servant-catalogue-sync";
import {
  syncServantImages,
  type ServantImageReport,
} from "./servant-image-sync";

type Options = Parameters<typeof runEventSchedulePipeline>[1] & {
  announcementBackfillDays?: number;
};
type Dependencies = {
  progress?: ImportProgress;
  runSync?: typeof runEventSchedulePipeline;
  collectGlobalSources?: typeof collectGlobalSourcesWithAuthority;
  syncServants?: typeof syncServantCatalogue;
  syncImages?: typeof syncServantImages;
};

export async function runCompleteEventSchedule(
  database: PrismaClient,
  options: Options,
  authority: GlobalSourceAuthority,
  dependencies: Dependencies = {},
) {
  // Check collection authority before the JP importer can write.
  validateAnnouncementBackfillDays(options.announcementBackfillDays);
  await requireSourceAuthority(database, authority);
  const progress = dependencies.progress ?? createImportProgress();
  let servants: {
    examined: number;
    updated: number;
    status: "success" | "failed";
  };
  try {
    servants = {
      ...(await progress.stage("servant_catalogue", () =>
        (dependencies.syncServants ?? syncServantCatalogue)(
          database,
          options.dryRun,
        ),
      )),
      status: "success",
    };
  } catch (error) {
    servants = { examined: 0, updated: 0, status: "failed" };
    console.warn(
      JSON.stringify({
        event: "servant_catalogue_sync_failed",
        error: safeSyncFailure(error),
      }),
    );
  }
  const report = await progress.stage("jp_fandom", () =>
    (dependencies.runSync ?? runEventSchedulePipeline)(database, options, {
      progress,
    }),
  );
  let servantImages: ServantImageReport;
  try {
    // Run after event/banner work so newly created servant records are included.
    servantImages = await progress.stage("servant_images", () =>
      (dependencies.syncImages ?? syncServantImages)(database, options.dryRun),
    );
  } catch {
    servantImages = {
      status: "failed",
      examined: 0,
      pending: 0,
      uploaded: 0,
      reused: 0,
      updated: 0,
      failed: 1,
    };
  }
  let globalSources: Awaited<
    ReturnType<typeof collectGlobalSourcesWithAuthority>
  >;
  try {
    globalSources = await (
      dependencies.collectGlobalSources ?? collectGlobalSourcesWithAuthority
    )(
      database,
      authority,
      options.asOf,
      {},
      {
        dryRun: options.dryRun,
        progress,
        announcementBackfillDays: options.announcementBackfillDays,
      },
    );
  } catch (error) {
    globalSources = {
      atlas: { status: "failed", inserted: 0, examined: 0 },
      publisher: {
        status: "failed",
        inserted: 0,
        examined: 0,
        coverageLimited: false,
        publishedCount: 0,
        publishedBannerCount: 0,
        publicationFailures: 0,
      },
      publication: "blocked",
    };
    console.warn(
      JSON.stringify({
        event: "event_schedule_global_sources_failed",
        error: safeSyncFailure(error),
      }),
    );
  }
  const failed =
    servants.status === "failed" ||
    servantImages.status === "failed" ||
    globalSources.atlas.status === "failed" ||
    globalSources.publisher.status === "failed" ||
    globalSources.publisher.publicationFailures > 0;
  return {
    ...report,
    servants,
    servantImages,
    globalSources,
    runId: progress.runId,
    importStatus: failed
      ? ("partial_failure" as const)
      : ("succeeded" as const),
  };
}
