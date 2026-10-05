import { env } from "~/env";
import { timelineWindows } from "~/app/timeline/_lib/progressive-timeline";
import { getCachedTimelineWindow } from "~/server/api/routers/timeline";
import { db } from "~/server/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { collectDailyGlobalSources } from "./global-source-cron";
import { cronSourceAuthority } from "./global-source-authority";
import type { PrismaClient } from "../../../generated/prisma";

import { runEventSchedulePipeline } from "../../../scripts/lib/event-schedule-pipeline.mjs";
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

type PipelineDatabase = Parameters<typeof runEventSchedulePipeline>[0];
type PipelineOptions = Parameters<typeof runEventSchedulePipeline>[1];

type CronDependencies = {
  database?: PrismaClient;
  now?: () => Date;
  runSync?: (
    database: PipelineDatabase,
    options: PipelineOptions,
  ) => Promise<unknown>;
  invalidateCache?: () => void | Promise<void>;
  warmCache?: (asOf: Date) => Promise<void>;
  secret?: string;
  collectGlobalSources?: typeof collectDailyGlobalSources;
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
  try {
    cronSourceAuthority(request, secret);
  } catch {
    return json({ ok: false, error: "Unauthorised." }, 401);
  }

  const runSync = dependencies.runSync ?? runEventSchedulePipeline;
  const started = performance.now();
  const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const durationMs = () => Math.round(performance.now() - started);
  console.info(
    JSON.stringify({ event: "event_schedule_sync_started", startedAt }),
  );
  let stage = "pipeline";
  try {
    const asOf = new Date(startedAt);
    const rawReport: unknown = await runSync(dependencies.database ?? db, {
      dryRun: false,
      asOf,
      sourceFile: null,
      warSourceFile: null,
      masterMissionSourceFile: null,
      outputPath: null,
    });
    stage = "summary";
    const report = summariseEventSchedule(syncReportSchema.parse(rawReport));
    stage = "global_sources";
    let globalSources: Awaited<ReturnType<typeof collectDailyGlobalSources>>;
    try {
      globalSources = await (
        dependencies.collectGlobalSources ?? collectDailyGlobalSources
      )(dependencies.database ?? db, request, secret, asOf);
    } catch (error) {
      globalSources = {
        atlas: { status: "failed", inserted: 0, examined: 0 },
        publisher: {
          status: "failed",
          inserted: 0,
          examined: 0,
          coverageLimited: false,
        },
        publication: "disabled",
      };
      console.warn(
        JSON.stringify({
          event: "event_schedule_global_sources_failed",
          error: safeSyncFailure(error),
        }),
      );
    }
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
      globalSources.publisher.coverageLimited
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
