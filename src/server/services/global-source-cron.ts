import type { PrismaClient } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
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
  execution: { dryRun?: boolean } = {},
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
  execution: { dryRun?: boolean } = {},
) {
  await requireSourceAuthority(database, authority);
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
      publicationFailures: 0,
    },
    publication: "official-dates" as "official-dates" | "blocked",
  };
  try {
    const atlas = await (
      dependencies.collectAtlas ?? collectGlobalCandidatesWithAuthority
    )(database, authority, { from, through }, {}, execution);
    result.atlas = {
      status: "success",
      inserted: atlas.inserted,
      examined: atlas.examined,
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
      { ...execution, allowPublication: result.atlas.status === "success" },
    );
    if (result.atlas.status !== "success") result.publication = "blocked";
    result.publisher = {
      status: "success",
      inserted: publisher.inserted,
      examined: publisher.examined,
      coverageLimited: publisher.coverageLimited,
      publishedCount: publisher.publishedCount ?? 0,
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
