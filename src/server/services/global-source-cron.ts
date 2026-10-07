import type { PrismaClient } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  GLOBAL_CAMPAIGN_IDENTITY_LIMITS,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import { safeSyncFailure } from "../../../scripts/lib/event-schedule-monitoring.mjs";
import {
  cronSourceAuthority,
  requireSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { collectGlobalCandidatesWithAuthority } from "./global-candidate-queue";
import { collectAnnouncementsWithAuthority } from "./global-announcement-collection";
import { createImportProgress, type ImportProgress } from "./import-progress";
import { boundedGlobalExportLoader } from "./global-export-source";

type Dependencies = {
  collectAtlas?: typeof collectGlobalCandidatesWithAuthority;
  collectPublisher?: typeof collectAnnouncementsWithAuthority;
};

export async function collectDailyGlobalSources(
  database: PrismaClient,
  request: Request,
  secret: string | undefined,
  asOf: Date,
  dependencies: Dependencies = {},
  execution: { dryRun?: boolean; progress?: ImportProgress } = {},
) {
  const authority = cronSourceAuthority(request, secret);
  return collectGlobalSourcesWithAuthority(
    database,
    authority,
    asOf,
    dependencies,
    execution,
  );
}

export async function collectGlobalSourcesWithAuthority(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  asOf: Date,
  dependencies: Dependencies = {},
  execution: { dryRun?: boolean; progress?: ImportProgress } = {},
) {
  await requireSourceAuthority(database, authority);
  const progress = execution.progress ?? createImportProgress();
  const from = new Date(asOf);
  from.setUTCHours(0, 0, 0, 0);
  const through = new Date(
    from.getTime() +
      (GLOBAL_SOURCE_LIMITS.maxRangeDays - 1) * MILLISECONDS_PER_DAY,
  );
  const result = {
    atlas: {
      status: "failed" as "success" | "failed",
      inserted: 0,
      examined: 0,
    },
    publisher: {
      status: "failed" as "success" | "failed",
      inserted: 0,
      examined: 0,
      coverageLimited: false,
      publishedCount: 0,
      publishedBannerCount: 0,
      publicationFailures: 0,
    },
    publication: "official-dates" as "official-dates" | "blocked",
  };
  try {
    const load = boundedGlobalExportLoader();
    const exports = new Map<string, ReturnType<typeof load>>();
    const cachedLoad: typeof load = (region, options) => {
      const key = `${region}:${options?.sourceFile ?? ""}`;
      let result = exports.get(key);
      if (!result) {
        result = load(region, options);
        exports.set(key, result);
      }
      return result;
    };
    const collectAtlas =
      dependencies.collectAtlas ?? collectGlobalCandidatesWithAuthority;
    const recent = await progress.stage("atlas_global_recent", () =>
      collectAtlas(
        database,
        authority,
        {
          from: new Date(
            from.getTime() -
              GLOBAL_CAMPAIGN_IDENTITY_LIMITS.lookbackDays *
                MILLISECONDS_PER_DAY,
          ),
          through: new Date(from.getTime() - 1),
        },
        { loadSource: cachedLoad },
        execution,
      ),
    );
    const atlas = await progress.stage("atlas_global", () =>
      collectAtlas(
        database,
        authority,
        { from, through },
        { loadSource: cachedLoad },
        execution,
      ),
    );
    result.atlas = {
      status: "success",
      inserted: recent.inserted + atlas.inserted,
      examined: recent.examined + atlas.examined,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "global_source_collection_failed",
        source: "atlas",
        error: safeSyncFailure(error),
      }),
    );
  }
  try {
    const publisher = await (
      dependencies.collectPublisher ?? collectAnnouncementsWithAuthority
    )(
      database,
      authority,
      {},
      {},
      {
        ...execution,
        progress,
        allowPublication: result.atlas.status === "success",
      },
    );
    if (result.atlas.status !== "success") result.publication = "blocked";
    result.publisher = {
      status: "success",
      inserted: publisher.inserted,
      examined: publisher.examined,
      coverageLimited: publisher.coverageLimited,
      publishedCount: publisher.publishedCount ?? 0,
      publishedBannerCount: publisher.publishedBannerCount ?? 0,
      publicationFailures: publisher.publicationFailures ?? 0,
    };
  } catch (error) {
    result.publication = "blocked";
    console.warn(
      JSON.stringify({
        event: "global_source_collection_failed",
        source: "publisher",
        error: safeSyncFailure(error),
      }),
    );
  }
  return result;
}
