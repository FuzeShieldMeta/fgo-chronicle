import type { PrismaClient } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import { safeSyncFailure } from "../../../scripts/lib/event-schedule-monitoring.mjs";
import { cronSourceAuthority } from "./global-source-authority";
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
) {
  const authority = cronSourceAuthority(request, secret);
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
    },
    publication: "disabled" as const,
  };
  try {
    const atlas = await (
      dependencies.collectAtlas ?? collectGlobalCandidatesWithAuthority
    )(database, authority, { from, through });
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
    )(database, authority, {});
    result.publisher = {
      status: "success",
      inserted: publisher.inserted,
      examined: publisher.examined,
      coverageLimited: publisher.coverageLimited,
    };
  } catch (error) {
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
