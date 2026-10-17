import { env } from "~/env";
import { timelineWindows } from "~/app/timeline/_lib/progressive-timeline";
import { getCachedTimelineWindow } from "~/server/api/routers/timeline";
import { db } from "~/server/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import type { GlobalSourceAuthority } from "./global-source-authority";
import { cronSourceAuthority } from "./global-source-authority";
import { runGeneralSync } from "./general-sync";
import type { PrismaClient } from "../../../generated/prisma";

import {
  safeSyncFailure,
  summariseEventSchedule,
} from "../../../scripts/lib/event-schedule-monitoring.mjs";

const stageCount = z.number().int().nonnegative().safe();
const syncReportSchema = z.object({
  runId: z.string().uuid(),
  importStatus: z.enum(["succeeded", "partial_failure"]),
  banners: z.object({
    status: z.literal("success"),
    examined: stageCount,
    imported: stageCount,
    changedBanners: stageCount,
    servants: stageCount,
  }),
  servants: z.object({
    status: z.enum(["success", "failed"]),
    examined: stageCount,
    updated: stageCount,
  }),
  servantImages: z.object({
    status: z.enum(["success", "failed", "unavailable"]),
    examined: stageCount,
    pending: stageCount,
    uploaded: stageCount,
    reused: stageCount,
    updated: stageCount,
    failed: stageCount,
  }),
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

type CronDependencies = Pick<
  NonNullable<Parameters<typeof runGeneralSync>[3]>,
  | "runSync"
  | "collectGlobalSources"
  | "syncServants"
  | "syncImages"
  | "downloadBanners"
  | "importBanners"
> & {
  database?: PrismaClient;
  now?: () => Date;
  invalidateCache?: () => void | Promise<void>;
  warmCache?: (asOf: Date) => Promise<void>;
  secret?: string;
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
    const rawReport = await runGeneralSync(
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
        syncServants: dependencies.syncServants,
        syncImages: dependencies.syncImages,
        downloadBanners: dependencies.downloadBanners,
        importBanners: dependencies.importBanners,
      },
    );
    stage = "summary";
    const parsed = syncReportSchema.parse(rawReport);
    const report = summariseEventSchedule(parsed);
    const { runId, importStatus, servants, servantImages, banners } = parsed;
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
      importStatus === "partial_failure"
        ? "failed"
        : report.totals.warningCount > 0 ||
            !cacheWarmed ||
            globalSources.publisher.coverageLimited ||
            servantImages.status === "unavailable"
          ? "warning"
          : "success";
    const completion = {
      runId,
      importStatus,
      startedAt,
      durationMs: durationMs(),
      status,
      cacheWarmed,
      ...report,
      globalSources,
      servants,
      servantImages,
      banners,
    };
    const log =
      status === "failed"
        ? console.error
        : status === "warning"
          ? console.warn
          : console.info;
    log(
      JSON.stringify({ event: `event_schedule_sync_${status}`, ...completion }),
    );
    return json(
      { ok: status !== "failed", ...completion },
      status === "failed" ? 500 : 200,
    );
  } catch (error) {
    // Banner publication can have committed before a later schedule stage fails.
    // Invalidate without warming so those successful writes are not hidden by stale cache.
    try {
      await (dependencies.invalidateCache ?? invalidateTimelineCache)();
    } catch {
      console.warn(
        JSON.stringify({
          event: "event_schedule_cache_invalidation_failed",
          startedAt,
        }),
      );
    }
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
