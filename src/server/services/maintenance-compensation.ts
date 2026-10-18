import { createHash } from "node:crypto";
import { safeSyncFailure } from "../../../scripts/lib/event-schedule-monitoring.mjs";
import type { PrismaClient, Prisma } from "../../../generated/prisma";
import {
  GLOBAL_SOURCE_LIMITS as TRANSACTION,
  GLOBAL_ANNOUNCEMENT_LIMITS,
  MAINTENANCE_SOURCE_LIMITS as LIMITS,
} from "~/shared/global-reconciliation-config";
import {
  requireSourceAuthority,
  lockSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import {
  effectiveEvent,
  eventIsHidden,
  rewardDateShift,
} from "./effective-schedule";
import {
  fetchJpMaintenanceHtml,
  jpMaintenanceLinks,
  parseMaintenanceNotice,
  type MaintenanceNotice,
} from "./maintenance-notices";
import { fetchPublisherHtml } from "./global-announcement-source";
import { discoverPublisherArticles } from "./global-announcement-parser";

const sourcePrefix = "maintenance-notice:";
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nameKey = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const maintenanceEventInclude = {
  curation: true,
  globalBaseline: true,
  dateOverlay: { include: { candidate: { select: { name: true } } } },
  rewardSources: {
    include: {
      rewards: { include: { globalBaseline: true, dateOverlay: true } },
    },
  },
} satisfies Prisma.EventInclude;
type EventRecord = Prisma.EventGetPayload<{
  include: typeof maintenanceEventInclude;
}>;

export type MaintenanceReport = {
  status: "success" | "failed";
  examined: number;
  matched: number;
  changed: number;
  confirmed: number;
  unresolved: number;
  failed: number;
  coverageLimited: boolean;
};

// All retrieval happens before publication; neither HTML parsing nor network I/O
// holds database locks. Only links observed on the fixed publisher indices run.
export async function loadMaintenanceNotices(
  asOf: Date,
  fetchFn: typeof fetch = fetch,
) {
  const signal = AbortSignal.timeout(LIMITS.collectionTimeoutMs);
  const urls = new Map<string, "JP" | "NA">();
  const cutoffYear = asOf.getUTCFullYear() - LIMITS.projectionYears;
  let coverageLimited = false;
  for (let page = 1; page <= LIMITS.maxIndexPages; page++) {
    const index = `https://news.fate-go.jp/maintenance/${page === 1 ? "" : `page/${page}/`}`;
    const links = jpMaintenanceLinks(
      await fetchJpMaintenanceHtml(index, fetchFn, signal),
      index,
    );
    const recent = links.filter(
      (url) => Number(new URL(url).pathname.slice(1, 5)) >= cutoffYear,
    );
    for (const url of recent) {
      if (urls.size >= LIMITS.maxArticles) {
        coverageLimited = true;
        break;
      }
      urls.set(url, "JP");
    }
    if (!links.length || recent.length < links.length) break;
    if (page === LIMITS.maxIndexPages) coverageLimited = true;
  }
  let next: string | null = "https://webview.fate-go.us/maintenance/";
  const visited = new Set<string>();
  // Reserve a separate bounded set for recent Global confirmations.
  for (
    let page = 0;
    next && page < GLOBAL_ANNOUNCEMENT_LIMITS.maxIndexPages;
    page++
  ) {
    if (visited.has(next)) break;
    visited.add(next);
    const found = discoverPublisherArticles(
      await fetchPublisherHtml(next, { fetchFn, signal }),
      next,
    );
    for (const url of found.articleUrls) {
      if (urls.size >= LIMITS.maxArticles * 2) {
        coverageLimited = true;
        break;
      }
      urls.set(url, "NA");
    }
    next = found.nextUrl;
  }
  if (next) coverageLimited = true;
  const entries = [...urls];
  const notices: MaintenanceNotice[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: LIMITS.concurrency }, async () => {
      for (;;) {
        const entry = entries[cursor++];
        if (!entry) return;
        const [url, region] = entry;
        const body =
          region === "JP"
            ? await fetchJpMaintenanceHtml(url, fetchFn, signal)
            : await fetchPublisherHtml(url, { fetchFn, signal });
        const notice = parseMaintenanceNotice(body, url, region);
        // Future completion dates cannot prove that maintenance has finished.
        if (notice && new Date(notice.endsAt) <= asOf) notices.push(notice);
      }
    }),
  );
  return { notices, coverageLimited };
}

function noticeMatches(notice: MaintenanceNotice, event: EventRecord) {
  if (eventIsHidden(event)) return false;
  const effective = effectiveEvent(event);
  const startsAt =
    notice.region === "JP" ? event.sourceStartsAt : effective.startsAt;
  if (startsAt?.getTime() !== Date.parse(notice.endsAt)) return false;
  const startStatus =
    event.dateOverlay?.startStatus ??
    (event.globalBaseline ? "OFFICIAL" : event.status);
  if (notice.region === "NA" && startStatus !== "OFFICIAL") return false;
  const names =
    notice.region === "JP"
      ? [event.name]
      : [
          event.globalBaseline?.name,
          effective.name,
          event.dateOverlay?.candidate?.name.replace(/^(?:\[[^\]]*\]\s*)+/, ""),
        ];
  return names.some(
    (name) =>
      name &&
      notice.launchNames.some((launch) => nameKey(launch) === nameKey(name)),
  );
}

export function matchMaintenanceEvent(
  notice: MaintenanceNotice,
  events: EventRecord[],
) {
  const matches = events.filter((event) => noticeMatches(notice, event));
  // A notice can launch a main event and several campaigns. Attach its single
  // payment to the main event; never multiply it by the number of launches.
  const main = matches.filter((event) => event.type === "MAIN_EVENT");
  const choices = main.length ? main : matches;
  return choices.length === 1 ? choices[0]! : null;
}

async function publishNotice(
  tx: Prisma.TransactionClient,
  authority: GlobalSourceAuthority,
  notice: MaintenanceNotice,
  events: EventRecord[],
  dryRun: boolean,
) {
  const event = matchMaintenanceEvent(notice, events);
  if (!event) return { matched: false, changed: false, confirmed: false };
  const otherMaintenance = event.rewardSources.filter(
    (source) => source.type === "MAINTENANCE",
  );
  // A manually entered or differently sourced payment needs review, not a
  // guessed merge. Existing user preferences remain attached to their IDs.
  if (
    otherMaintenance.some(
      (source) => !source.sourceKey.startsWith(sourcePrefix),
    )
  )
    return { matched: false, changed: false, confirmed: false };
  const own = otherMaintenance.filter((source) =>
    source.sourceKey.startsWith(sourcePrefix),
  );
  if (own.length > 1)
    return { matched: false, changed: false, confirmed: false };
  const existing = own[0];
  if (
    existing &&
    notice.region === "JP" &&
    existing.sourceKey !== `${sourcePrefix}JP:${new URL(notice.url).pathname}`
  )
    return { matched: false, changed: false, confirmed: false };
  if (existing?.status === "OFFICIAL" && notice.region === "JP")
    return { matched: true, changed: false, confirmed: false };
  const reward = existing?.rewards[0];
  if (
    existing &&
    (existing.rewards.length !== 1 || reward?.itemType !== "SAINT_QUARTZ")
  )
    return { matched: false, changed: false, confirmed: false };
  const official = notice.region === "NA";
  // Store the unshifted value: the regular effective-reward calculation applies
  // a curator's family offset exactly once when reading it.
  const expectedAt = official
    ? new Date(notice.distributionStartsAt)
    : reward?.dateOverlay && reward.expectedAt
      ? reward.expectedAt
      : new Date(
          effectiveEvent(event).startsAt.getTime() - rewardDateShift(event),
        );
  const eligibility = `${official ? "Global maintenance compensation." : "Projected from JP maintenance. Original JP eligibility:"} ${notice.recipients} Source: ${notice.url}`;
  const desired = { amount: notice.amount, expectedAt, eligibility };
  const previous = official ? reward?.globalBaseline : reward;
  if (
    existing &&
    previous &&
    existing.evidenceUrl === notice.url &&
    existing.status === (official ? "OFFICIAL" : "PROJECTED") &&
    previous.amount === desired.amount &&
    previous.expectedAt?.getTime() === expectedAt.getTime() &&
    previous.eligibility === eligibility
  )
    return { matched: true, changed: false, confirmed: false };
  const sourceKey =
    existing?.sourceKey ??
    `${sourcePrefix}${notice.region}:${new URL(notice.url).pathname}`;
  const linked = await tx.rewardSource.findUnique({
    where: { sourceKey },
    select: { eventId: true },
  });
  if (linked && linked.eventId !== event.id)
    return { matched: false, changed: false, confirmed: false };
  if (dryRun) return { matched: true, changed: true, confirmed: official };
  const source = await tx.rewardSource.upsert({
    where: { sourceKey },
    create: {
      sourceKey,
      eventId: event.id,
      name: "Maintenance compensation",
      type: "MAINTENANCE",
      status: official ? "OFFICIAL" : "PROJECTED",
      evidenceUrl: notice.url,
    },
    update: {
      status: official ? "OFFICIAL" : "PROJECTED",
      evidenceUrl: notice.url,
    },
  });
  const definition = await tx.rewardDefinition.upsert({
    where: { sourceKey: `${sourceKey}:saint-quartz` },
    create: {
      sourceKey: `${sourceKey}:saint-quartz`,
      rewardSourceId: source.id,
      itemType: "SAINT_QUARTZ",
      ...desired,
      dateBasis: official ? "ABSOLUTE" : "START_RELATIVE",
      nature: "DETERMINISTIC",
      defaultIncluded: true,
    },
    update: official ? { dateBasis: "ABSOLUTE" } : desired,
  });
  if (official) {
    // Explicit distribution time replaces the earlier family-shift estimate.
    await tx.rewardDateOverlay.deleteMany({
      where: { rewardId: definition.id },
    });
    const candidateData = {
      sourceKind: "PUBLISHER_ANNOUNCEMENT",
      sourceRecordId: `${new URL(notice.url).pathname}:maintenance`,
      contentHash: notice.contentHash,
      assessmentHash: hash({ eventId: event.id, notice }),
    };
    const candidate = await tx.globalEventCandidate.upsert({
      where: {
        sourceKind_sourceRecordId_contentHash_assessmentHash: candidateData,
      },
      create: {
        ...candidateData,
        sourceUrl: notice.url,
        retrievedAt: new Date(),
        name: "Maintenance compensation",
        startsAt: new Date(notice.startsAt),
        endsAt: new Date(notice.endsAt),
        targetEventId: event.id,
        reasons: [],
        snapshot: json({
          kind: "MAINTENANCE",
          publicationAllowed: false,
          ...notice,
        }),
      },
      update: {},
    });
    const baseline = {
      eventId: event.id,
      candidateId: candidate.id,
      itemType: "SAINT_QUARTZ" as const,
      ...desired,
      eventStartsAt: effectiveEvent(event).startsAt,
      nature: "DETERMINISTIC" as const,
      defaultIncluded: true,
    };
    await tx.rewardGlobalBaseline.upsert({
      where: { rewardId: definition.id },
      create: { rewardId: definition.id, ...baseline },
      update: baseline,
    });
  }
  await tx.curatorChange.create({
    data: {
      actorId: authority.actorId,
      targetKind: "REWARD",
      targetId: definition.id,
      action: official ? "MAINTENANCE_CONFIRMED" : "MAINTENANCE_PROJECTED",
      reason: "Explicit publisher compensation matched to the event launch.",
      before: json(reward ?? null),
      after: json({
        notice,
        eventId: event.id,
        rewardId: definition.id,
        ...desired,
      }),
    },
  });
  return { matched: true, changed: true, confirmed: official };
}

export async function syncMaintenanceCompensation(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  options: { asOf: Date; dryRun: boolean },
  load: typeof loadMaintenanceNotices = loadMaintenanceNotices,
): Promise<MaintenanceReport> {
  await requireSourceAuthority(database, authority);
  if (!Number.isFinite(options.asOf.getTime()))
    throw Error("Invalid maintenance collection date.");
  const collection = await load(options.asOf);
  const report: MaintenanceReport = {
    status: "success",
    examined: collection.notices.length,
    matched: 0,
    changed: 0,
    confirmed: 0,
    unresolved: 0,
    failed: 0,
    coverageLimited: collection.coverageLimited,
  };
  // JP estimates first, then Global confirmations, always retaining the reward ID.
  const notices = [...collection.notices].sort((a, b) =>
    a.region === b.region
      ? a.url.localeCompare(b.url)
      : a.region === "JP"
        ? -1
        : 1,
  );
  const snapshot = await database.event.findMany({
    relationLoadStrategy: "join",
    include: maintenanceEventInclude,
    take: LIMITS.maxEvents + 1,
    orderBy: { id: "asc" },
  });
  if (snapshot.length > LIMITS.maxEvents)
    throw Error("Maintenance matching exceeds the event limit.");
  for (const notice of notices) {
    try {
      const preview = await publishNotice(
        database,
        authority,
        notice,
        snapshot,
        true,
      );
      // No transaction (or write lock) is needed for a dry run or an unchanged row.
      const result =
        options.dryRun || !preview.changed
          ? preview
          : await database.$transaction(
              async (tx) => {
                await lockSourceAuthority(tx, authority);
                await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('global-source-candidates'))::text`;
                const opening = new Date(notice.endsAt);
                const events = await tx.event.findMany({
                  where:
                    notice.region === "JP"
                      ? { sourceStartsAt: opening }
                      : {
                          OR: [
                            { startsAt: opening },
                            { globalBaseline: { startsAt: opening } },
                            { dateOverlay: { startsAt: opening } },
                            { curation: { active: true, startsAt: opening } },
                          ],
                        },
                  include: maintenanceEventInclude,
                  take: LIMITS.maxEvents + 1,
                  orderBy: { id: "asc" },
                });
                if (events.length > LIMITS.maxEvents)
                  throw Error("Maintenance matching exceeds the event limit.");
                const target = matchMaintenanceEvent(notice, events);
                if (target)
                  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${target.id} FOR UPDATE`;
                // Re-read after the event lock so curator edits cannot stale the match.
                const fresh = target
                  ? await tx.event.findUnique({
                      where: { id: target.id },
                      include: maintenanceEventInclude,
                    })
                  : null;
                return publishNotice(
                  tx,
                  authority,
                  notice,
                  fresh ? [fresh] : [],
                  options.dryRun,
                );
              },
              {
                maxWait: TRANSACTION.transactionMaxWaitMs,
                timeout: TRANSACTION.transactionTimeoutMs,
              },
            );
      report.matched += Number(result.matched);
      report.changed += Number(result.changed);
      report.confirmed += Number(result.confirmed);
      report.unresolved += Number(!result.matched);
    } catch (error) {
      report.status = "failed";
      report.failed++;
      console.warn(
        JSON.stringify({
          event: "maintenance_publication_failed",
          source: notice.url,
          error: safeSyncFailure(error),
        }),
      );
    }
  }
  return report;
}
