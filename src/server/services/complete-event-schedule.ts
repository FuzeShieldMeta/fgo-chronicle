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
import { downloadAtlasServantCatalogues } from "../../../scripts/lib/atlas-servant-catalogue.mjs";
import type { GlobalSummonCatalogue } from "./global-summon-servants";
import {
  syncMaintenanceCompensation,
  type MaintenanceReport,
} from "./maintenance-compensation";
import {
  syncServantImages,
  type ServantImageReport,
} from "./servant-image-sync";

import {
  syncBannerFamilyTiming,
  type BannerFamilyTimingReport,
} from "./banner-family-timing-sync";

type Options = Parameters<typeof runEventSchedulePipeline>[1] & {
  announcementBackfillDays?: number;
};
type Dependencies = {
  progress?: ImportProgress;
  runSync?: typeof runEventSchedulePipeline;
  collectGlobalSources?: typeof collectGlobalSourcesWithAuthority;
  syncServants?: typeof syncServantCatalogue;
  downloadServants?: typeof downloadAtlasServantCatalogues;
  syncImages?: typeof syncServantImages;
  syncMaintenance?: typeof syncMaintenanceCompensation;
  syncBannerFamilies?: typeof syncBannerFamilyTiming;
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
  let servantCatalogue: GlobalSummonCatalogue | undefined;
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
          async () => {
            const catalogue = await (
              dependencies.downloadServants ?? downloadAtlasServantCatalogues
            )();
            servantCatalogue = catalogue;
            return catalogue;
          },
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
        ...(servants.status === "success" && servantCatalogue
          ? { servantCatalogue }
          : {}),
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
  let maintenance: MaintenanceReport;
  try {
    maintenance = await progress.stage("maintenance_compensation", () =>
      (dependencies.syncMaintenance ?? syncMaintenanceCompensation)(
        database,
        authority,
        options,
      ),
    );
  } catch (error) {
    maintenance = {
      status: "failed",
      examined: 0,
      matched: 0,
      changed: 0,
      confirmed: 0,
      unresolved: 0,
      failed: 1,
      coverageLimited: true,
    };
    console.warn(
      JSON.stringify({
        event: "maintenance_compensation_failed",
        error: safeSyncFailure(error),
      }),
    );
  }
  let bannerFamilyTiming: BannerFamilyTimingReport;
  try {
    bannerFamilyTiming = await progress.stage("reviewed_family_timing", () =>
      (dependencies.syncBannerFamilies ?? syncBannerFamilyTiming)(
        database,
        authority,
        options.dryRun,
      ),
    );
  } catch (error) {
    bannerFamilyTiming = {
      status: "failed",
      examined: 0,
      changed: 0,
      unchanged: 0,
      held: [],
    };
    console.warn(
      JSON.stringify({
        event: "reviewed_family_timing_failed",
        error: safeSyncFailure(error),
      }),
    );
  }
  const failed =
    bannerFamilyTiming.status === "failed" ||
    maintenance.status === "failed" ||
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
    maintenance,
    bannerFamilyTiming,
    runId: progress.runId,
    importStatus: failed
      ? ("partial_failure" as const)
      : ("succeeded" as const),
  };
}
