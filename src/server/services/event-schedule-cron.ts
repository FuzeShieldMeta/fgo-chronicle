import { env } from "~/env";
import { timelineWindows } from "~/app/timeline/_lib/progressive-timeline";
import { getCachedTimelineWindow } from "~/server/api/routers/timeline";
import { db } from "~/server/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import type { collectGlobalSourcesWithAuthority } from "./global-source-cron";
import type { GlobalSourceAuthority } from "./global-source-authority";
import { cronSourceAuthority } from "./global-source-authority";
import { runCompleteEventSchedule } from "./complete-event-schedule";
import type { PrismaClient } from "../../../generated/prisma";

import type { runEventSchedulePipeline } from "../../../scripts/lib/event-schedule-pipeline.mjs";
import {
  safeSyncFailure,
  summariseEventSchedule,
} from "../../../scripts/lib/event-schedule-monitoring.mjs";

const syncReportSchema = z.object({
  atlas: z.unknown(),
  masterMissions: z.unknown(),
  fandom: z.object({
    atlasFetched: z.number(),
    atlasSelected: z.number(),
    fandomListEntries: z.number(),
    matchedAtlas: z.number(),
    reviewCandidates: z.number(),
    heldMatchedRewardSources: z.array(z.unknown()),
    explicitExclusions: z.array(z.unknown()),
    unresolved: z.array(z.unknown()),
    upcoming: z.array(z.object({ status: z.string() }).passthrough()),
    publication: z.unknown(),
  }),
});

type CronDependencies = {
  database?: PrismaClient;
  now?: () => Date;
  runSync?: typeof runEventSchedulePipeline;
  invalidateCache?: () => void | Promise<void>;
  warmCache?: (asOf: Date) => Promise<void>;
  secret?: string;
  collectGlobalSources?: typeof collectGlobalSourcesWithAuthority;
};

function invalidateTimelineCache() {
  revalidateTag("timeline-public-data");
}

async function warmTimelineCache(asOf: Date) {
  const scheduleStartDay = asOf.toISOString().slice(0, 10);
  for (const { index } of timelineWindows(scheduleStartDay)) {
    await getCachedTimelineWindow({ scheduleStartDay, index });
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status });
}

export async function handleEventScheduleCron(
  request: Request,
  dependencies: CronDependencies = {},
) {
  const secret = dependencies.secret ?? env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return json(
      { ok: false, error: "Event schedule synchronisation is not configured." },
      503,
    );
  }
  let authority: GlobalSourceAuthority;
  try {
    authority = cronSourceAuthority(request, secret);
  } catch {
    return json({ ok: false, error: "Unauthorised." }, 401);
  }

  const started = performance.now();
  const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const durationMs = () => Math.round(performance.now() - started);
  console.info(
    JSON.stringify({ event: "event_schedule_sync_started", startedAt }),
  );
  let stage = "pipeline";
  try {
    const asOf = new Date(startedAt);
    const rawReport = await runCompleteEventSchedule(
      dependencies.database ?? db,
      {
        dryRun: false,
        asOf,
        sourceFile: null,
        warSourceFile: null,
        masterMissionSourceFile: null,
        outputPath: null,
      },
      authority,
      {
        runSync: dependencies.runSync,
        collectGlobalSources: dependencies.collectGlobalSources,
      },
    );
    stage = "summary";
    const report = summariseEventSchedule(syncReportSchema.parse(rawReport));
    const { globalSources } = rawReport;
    stage = "cache";
    let cacheWarmed = true;
    try {
      await (dependencies.invalidateCache ?? invalidateTimelineCache)();
      await (dependencies.warmCache ?? warmTimelineCache)(asOf);
    } catch (error) {
      cacheWarmed = false;
      console.warn(
        JSON.stringify({
          event: "event_schedule_cache_failed",
          startedAt,
          durationMs: durationMs(),
          error: safeSyncFailure(error),
        }),
      );
    }
    const status =
      report.totals.warningCount > 0 ||
      !cacheWarmed ||
      globalSources.atlas.status === "failed" ||
      globalSources.publisher.status === "failed" ||
      globalSources.publisher.coverageLimited ||
      globalSources.publisher.publicationFailures > 0
        ? "warning"
        : "success";
    const completion = {
      startedAt,
      durationMs: durationMs(),
      status,
      cacheWarmed,
      ...report,
      globalSources,
    };
    const log = status === "warning" ? console.warn : console.info;
    log(
      JSON.stringify({ event: `event_schedule_sync_${status}`, ...completion }),
    );
    return json({ ok: true, ...completion });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "event_schedule_sync_failed",
        stage,
        startedAt,
        durationMs: durationMs(),
        error: safeSyncFailure(error),
      }),
    );
    return json(
      { ok: false, error: "Event schedule synchronisation failed." },
      500,
    );
  }
}
