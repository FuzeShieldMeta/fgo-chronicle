import type { PrismaClient } from "../../../generated/prisma";
import { runEventSchedulePipeline } from "../../../scripts/lib/event-schedule-pipeline.mjs";
import { safeSyncFailure } from "../../../scripts/lib/event-schedule-monitoring.mjs";
import {
  requireSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { collectGlobalSourcesWithAuthority } from "./global-source-cron";

type Options = Parameters<typeof runEventSchedulePipeline>[1];
type Dependencies = {
  runSync?: typeof runEventSchedulePipeline;
  collectGlobalSources?: typeof collectGlobalSourcesWithAuthority;
};

export async function runCompleteEventSchedule(
  database: PrismaClient,
  options: Options,
  authority: GlobalSourceAuthority,
  dependencies: Dependencies = {},
) {
  // Check collection authority before the JP importer can write.
  await requireSourceAuthority(database, authority);
  const report = await (dependencies.runSync ?? runEventSchedulePipeline)(
    database,
    options,
  );
  let globalSources: Awaited<
    ReturnType<typeof collectGlobalSourcesWithAuthority>
  >;
  try {
    globalSources = await (
      dependencies.collectGlobalSources ?? collectGlobalSourcesWithAuthority
    )(database, authority, options.asOf, {}, { dryRun: options.dryRun });
  } catch (error) {
    globalSources = {
      atlas: { status: "failed", inserted: 0, examined: 0 },
      publisher: {
        status: "failed",
        inserted: 0,
        examined: 0,
        coverageLimited: false,
        publishedCount: 0,
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
  return { ...report, globalSources };
}
