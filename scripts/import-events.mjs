import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  normalizeAtlasEvent,
  normalizeAtlasMasterMission,
  normalizeAtlasWarRewards,
} from "./lib/atlas-event-adapter.mjs";
import { parseEventDataset } from "./lib/event-dataset.mjs";

const configSchema = z.object({
  schemaVersion: z.literal(1),
  families: z.array(
    z.object({
      sourceKey: z.string().min(1),
      name: z.string().min(1),
      atlasEvents: z.array(
        z.object({
          region: z.string().min(1),
          eventId: z.number().int().positive(),
        }),
      ),
    }),
  ),
  atlasMasterMissions: z
    .array(
      z.object({
        region: z.string().min(1),
        masterMissionId: z.number().int().positive(),
      }),
    )
    .default([]),
  supplementary: z.object({
    sources: z.array(z.unknown()),
    events: z.array(z.unknown()),
    rewardSources: z.array(z.unknown()),
    issues: z.array(z.unknown()),
  }),
});

function requiredEnvironmentPath(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function fetchAtlasRecord(url, label) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }

  const body = await response.text();
  return {
    raw: JSON.parse(body),
    contentHash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
}

function uniqueBySourceKey(values) {
  return [...new Map(values.map((value) => [value.sourceKey, value])).values()];
}

async function main() {
  const configPath = requiredEnvironmentPath("EVENT_SOURCE_CONFIG_PATH");
  const outputPath = requiredEnvironmentPath("EVENT_DATA_PATH");
  const config = configSchema.parse(await readJson(configPath));
  const retrievedAt = new Date().toISOString();
  const normalized = [];

  for (const family of config.families) {
    for (const atlasEvent of family.atlasEvents) {
      const eventUrl = `https://api.atlasacademy.io/nice/${atlasEvent.region}/event/${atlasEvent.eventId}`;
      const { raw, contentHash } = await fetchAtlasRecord(
        eventUrl,
        `Atlas event ${atlasEvent.eventId}`,
      );
      const normalizedEvent = normalizeAtlasEvent(raw, {
        region: atlasEvent.region,
        retrievedAt,
        contentHash,
        family,
      });
      normalized.push(normalizedEvent);

      for (const warId of raw.warIds ?? []) {
        const warUrl = `https://api.atlasacademy.io/nice/${atlasEvent.region}/war/${warId}`;
        const war = await fetchAtlasRecord(warUrl, `Atlas war ${warId}`);
        normalized.push(
          normalizeAtlasWarRewards(war.raw, {
            region: atlasEvent.region,
            retrievedAt,
            contentHash: war.contentHash,
            eventId: atlasEvent.eventId,
            eventSourceKey: normalizedEvent.event.sourceKey,
          }),
        );
      }
    }
  }

  for (const masterMission of config.atlasMasterMissions) {
    const missionUrl = `https://api.atlasacademy.io/nice/${masterMission.region}/mm/${masterMission.masterMissionId}`;
    const { raw, contentHash } = await fetchAtlasRecord(
      missionUrl,
      `Atlas Master Mission ${masterMission.masterMissionId}`,
    );
    normalized.push(
      normalizeAtlasMasterMission(raw, {
        region: masterMission.region,
        retrievedAt,
        contentHash,
      }),
    );
  }

  const dataset = parseEventDataset({
    schemaVersion: 1,
    generatedAt: retrievedAt,
    review: {
      status: "NEEDS_REVIEW",
      reviewedAt: null,
      note: null,
    },
    sources: uniqueBySourceKey([
      ...normalized.map(({ source }) => source),
      ...config.supplementary.sources,
    ]),
    families: uniqueBySourceKey(
      normalized.flatMap(({ family }) => (family ? [family] : [])),
    ),
    events: uniqueBySourceKey([
      ...normalized.flatMap(({ event }) => (event ? [event] : [])),
      ...config.supplementary.events,
    ]),
    rewardSources: uniqueBySourceKey([
      ...normalized.flatMap(({ rewardSources }) => rewardSources),
      ...config.supplementary.rewardSources,
    ]),
    issues: uniqueBySourceKey([
      ...normalized.flatMap(({ issues }) => issues),
      ...config.supplementary.issues,
    ]),
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);

  console.log(
    `Wrote ${dataset.events.length} events and ${dataset.rewardSources.length} reward sources to ${path.relative(process.cwd(), outputPath)}.`,
  );
  console.log(
    `Review required: ${dataset.issues.length} issue(s) were recorded; database import remains disabled until approval.`,
  );
}

main().catch((error) => {
  console.error("Event source import failed.");
  console.error(error);
  process.exitCode = 1;
});
