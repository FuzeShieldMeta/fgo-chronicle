import { env } from "~/env";
import { timelineWindows } from "~/app/timeline/_lib/progressive-timeline";
import { getCachedTimelineWindow } from "~/server/api/routers/timeline";
import { db } from "~/server/db";
import { revalidateTag } from "next/cache";
import { z } from "zod";

import { runEventSchedulePipeline } from "../../../scripts/lib/event-schedule-pipeline.mjs";

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
  database?: PipelineDatabase;
  now?: () => Date;
  runSync?: (
    database: PipelineDatabase,
    options: PipelineOptions,
  ) => Promise<unknown>;
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

function conciseReport(report: z.infer<typeof syncReportSchema>) {
  return {
    atlas: report.atlas,
    masterMissions: report.masterMissions,
    fandom: {
      atlasFetched: report.fandom.atlasFetched,
      atlasSelected: report.fandom.atlasSelected,
      fandomListEntries: report.fandom.fandomListEntries,
      matchedAtlas: report.fandom.matchedAtlas,
      reviewCandidates: report.fandom.reviewCandidates,
      heldMatchedRewardSources: report.fandom.heldMatchedRewardSources.length,
      explicitExclusions: report.fandom.explicitExclusions.length,
      unresolved: report.fandom.unresolved.length,
      missingUpcoming: report.fandom.upcoming.filter(
        ({ status }) => status === "MISSING_SOURCE_EVENT",
      ).length,
      publication: report.fandom.publication,
    },
  };
}

export async function handleEventScheduleCron(
  request: Request,
  dependencies: CronDependencies = {},
) {
  const secret = dependencies.secret ?? env.CRON_SECRET;
  if (!secret) {
    return json(
      { ok: false, error: "Event schedule synchronisation is not configured." },
      503,
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ ok: false, error: "Unauthorised." }, 401);
  }

  const runSync = dependencies.runSync ?? runEventSchedulePipeline;
  try {
    const asOf = (dependencies.now ?? (() => new Date()))();
    const rawReport: unknown = await runSync(dependencies.database ?? db, {
      dryRun: false,
      asOf,
      sourceFile: null,
      warSourceFile: null,
      masterMissionSourceFile: null,
      outputPath: null,
    });
    const report = syncReportSchema.parse(rawReport);
    try {
      await (dependencies.invalidateCache ?? invalidateTimelineCache)();
      await (dependencies.warmCache ?? warmTimelineCache)(asOf);
    } catch (error) {
      console.warn(
        "The event schedule synced, but its public cache could not warm.",
        error,
      );
    }
    return json({ ok: true, ...conciseReport(report) });
  } catch (error) {
    console.error("Scheduled event synchronisation failed.", error);
    return json(
      { ok: false, error: "Event schedule synchronisation failed." },
      500,
    );
  }
}
