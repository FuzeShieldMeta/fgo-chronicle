import {
  requireSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import {
  previewBannerSourceIdentities,
  registerBannerSourceIdentities,
} from "./banner-source-identity";
import {
  previewBannerSourcePublication,
  publishBannerSourceValues,
} from "./banner-source-publication";
import { loadJpBannerFamilyTiming } from "./jp-banner-family-timing";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import { BANNER_SYNC_LIMITS } from "~/shared/banner-sync-config.mjs";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { bannerDatasetSchema, bannerSourceKey } from "./banner-dataset";
import { auditJpBannerEvidence } from "./jp-banner-audit";
import {
  previewJpBannerIdentityMap,
  jpBannerIdentityTargetHash,
  JP_BANNER_IDENTITY_LIMITS,
} from "./jp-banner-identity";
import {
  inventoryJpBannerAnnouncements,
  JP_BANNER_INVENTORY_LIMITS,
} from "./jp-banner-inventory";
import { effectiveEvent, eventIsHidden } from "./effective-schedule";
import {
  jpBannerLaunchHour,
  projectJpBannerBoundary,
  JP_BANNER_PROJECTION_RULE,
} from "./jp-banner-projection";
import { bannerAnchorSourceFactsHash } from "./banner-family-timing-reference";

type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
type Database = PrismaClient | Prisma.TransactionClient;
const MAX_FAMILY_EVENTS = 25;
const include = {
  featured: true,
  sourceIdentities: true,
  sourcePublication: true,
  dateOverlay: true,
  summonLineups: { select: { id: true } },
  family: {
    include: {
      bannerTimingAnchor: true,
      events: {
        where: { sourceRegion: "JP" },
        take: MAX_FAMILY_EVENTS + 1,
        orderBy: { id: "asc" },
        include: { curation: true, globalBaseline: true, dateOverlay: true },
      },
    },
  },
} satisfies Prisma.BannerInclude;
type Target = Prisma.BannerGetPayload<{ include: typeof include }>;
const jpDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Qualification does not assert complete rosters or permit roster/name publication. */
export async function planJpBannerInitialization(
  database: Database,
  reports: readonly SourceReport[],
  baselineInput: unknown,
  asOf: Date,
  onlyTargetKeys?: readonly string[],
) {
  const baseline = bannerDatasetSchema.parse(baselineInput);
  if (
    !reports.length ||
    reports.some((r) => r.articleFailures.length || r.status !== "succeeded") ||
    new Set(reports.map((r) => r.servantCatalogue.contentHash)).size !== 1
  )
    throw new Error("JP banner source collection is incomplete.");
  const articles = reports.flatMap((r) =>
    r.articles.filter((a) => a.inspection),
  );
  if (new Set(articles.map((a) => a.url)).size !== articles.length)
    throw new Error("Duplicate JP source article.");
  const report: SourceReport = { ...reports[0]!, articles };
  const through = new Date(asOf);
  through.setUTCFullYear(
    through.getUTCFullYear() + JP_BANNER_PROJECTION_RULE.projectionYears,
  );
  const audit = auditJpBannerEvidence([{ ...report, articles }], baseline, {
    from: asOf.toISOString().slice(0, 10),
    through: through.toISOString().slice(0, 10),
  });
  if (audit.summary.omittedPairs || audit.summary.omittedWindows)
    throw new Error("JP initialization evidence budget exceeded.");
  const sourceByKey = new Map(audit.sourceReview.map((w) => [w.windowKey, w]));
  const pairByKey = new Map(audit.candidatePairs.map((p) => [p.pairKey, p]));
  const targetByKey = new Map(
    baseline.banners.map((b) => [bannerSourceKey(b), b]),
  );
  const wanted = onlyTargetKeys ? new Set(onlyTargetKeys) : null;
  const reviewedTargets = audit.sheetReview.filter(
    (row) => !wanted || wanted.has(row.sourceKey),
  );
  const targets: Target[] = [];
  for (
    let offset = 0;
    offset < reviewedTargets.length;
    offset += JP_BANNER_IDENTITY_LIMITS.maxMappings
  ) {
    const chunk = reviewedTargets.slice(
      offset,
      offset + JP_BANNER_IDENTITY_LIMITS.maxMappings,
    );
    targets.push(
      ...(await database.banner.findMany({
        where: { sourceKey: { in: chunk.map((row) => row.sourceKey) } },
        include,
      })),
    );
  }
  const registry = await database.bannerSourceIdentity.findMany({
    where: {
      sourceUrl: {
        in: [...new Set(audit.sourceReview.map((source) => source.sourceUrl))],
      },
    },
    take: BANNER_SYNC_LIMITS.maxFeaturedMemberships + 1,
  });
  if (registry.length > BANNER_SYNC_LIMITS.maxFeaturedMemberships)
    throw new Error("JP identity lookup budget exceeded.");
  const byKey = new Map(targets.map((b) => [b.sourceKey, b]));
  const decisions = [];
  for (const row of reviewedTargets) {
    const banner = byKey.get(row.sourceKey),
      owner = banner?.sourcePublication,
      stored = banner?.family?.bannerTimingAnchor;
    const reasons: string[] = [];
    if (!banner) reasons.push("TARGET_NOT_FOUND");
    else if (
      banner.hidden ||
      banner.status !== "PROJECTED" ||
      banner.sourceRegion !== "JP_PROJECTED" ||
      banner.dateOverlay ||
      banner.summonLineups.length
    )
      reasons.push("PROTECTED_OR_LINEUP_TARGET");
    const initialized =
      owner?.ownedFields.includes("TIMING") &&
      owner.sourceStartsAt &&
      owner.appliedAnchorStartsAt &&
      stored?.referenceStartsAt &&
      stored.sourceFactsHash;
    if (initialized && !reasons.length) {
      decisions.push({
        targetSourceKey: row.sourceKey,
        bannerId: banner!.id,
        familyId: banner!.familyId,
        status: "UNCHANGED" as const,
        reasons,
        proposal: null,
      });
      continue;
    }
    if (
      owner &&
      (owner.ownedFields.some(
        (field) => field !== "SOURCE" && field !== "TIMING",
      ) ||
        !owner.ownedFields.includes("TIMING") ||
        owner.sourceStartsAt ||
        owner.sourceEndsAt ||
        owner.appliedAnchorStartsAt)
    )
      reasons.push("EXISTING_OWNERSHIP_REQUIRES_REVIEW");
    const boundWindows = new Set(
      audit.sourceReview
        .filter((source) =>
          banner?.sourceIdentities.some(
            (identity) =>
              identity.sourceUrl === source.sourceUrl &&
              identity.periodEvidenceHash === source.periodEvidenceHash &&
              identity.articleContentHash === source.articleContentHash,
          ),
        )
        .map((source) => source.windowKey),
    );
    const candidates = boundWindows.size
      ? audit.candidatePairs.filter(
          (pair) =>
            pair.sheetSourceKey === row.sourceKey &&
            pair.observedIdsAgree &&
            boundWindows.has(pair.windowKey),
        )
      : row.preferredReviewPairKeys
          .map((key) => pairByKey.get(key)!)
          .filter(
            (pair) =>
              pair.observedIdsAgree && Math.abs(pair.utcStartDayDelta) <= 1,
          );
    if (!candidates.length)
      reasons.push("NO_VERIFIED_MATCH_IN_INSPECTED_SOURCES");
    else if (candidates.length !== 1) reasons.push("MULTIPLE_SOURCE_WINDOWS");
    const source =
      candidates.length === 1
        ? sourceByKey.get(candidates[0]!.windowKey)
        : null;
    if (source) {
      const competing = audit.candidatePairs.filter(
        (pair) =>
          pair.windowKey === source.windowKey &&
          pair.observedIdsAgree &&
          Math.abs(pair.utcStartDayDelta) <= 1,
      );
      if (!boundWindows.size && competing.length !== 1)
        reasons.push("SOURCE_WINDOW_MATCHES_MULTIPLE_TARGETS");
      if (
        registry.some(
          (identity) =>
            identity.sourceUrl === source.sourceUrl &&
            identity.periodEvidenceHash === source.periodEvidenceHash &&
            identity.bannerId !== banner?.id,
        )
      )
        reasons.push("SOURCE_WINDOW_ALREADY_BOUND_TO_OTHER_TARGET");
      if (source.evidenceKind !== "PARAGRAPH_PICKUP")
        reasons.push("HTML_SECTION_REGISTRATION_UNSUPPORTED");
    }
    let proposal = null;
    if (source && banner && !reasons.length) {
      const currentIds = banner.featured
        .map((m) => m.servantId)
        .sort((a, b) => a - b);
      if (JSON.stringify(currentIds) !== JSON.stringify(source.knownServantIds))
        reasons.push("DATABASE_MEMBER_SET_CHANGED");
      const same = banner.sourceIdentities.filter(
        (i) =>
          i.sourceUrl === source.sourceUrl &&
          i.periodEvidenceHash === source.periodEvidenceHash &&
          i.articleContentHash === source.articleContentHash,
      );
      if (banner.sourceIdentities.length && same.length !== 1)
        reasons.push("EXISTING_IDENTITY_EVIDENCE_CONFLICT");
      const sourceKey =
        same[0]?.sourceKey ??
        `publisher:JP:pickup:auto-${createHash("sha256").update(banner.id).digest("hex").slice(0, 32)}`;
      const mapping = {
        sourceKey,
        sourceUrl: source.sourceUrl,
        articleContentHash: source.articleContentHash,
        periodEvidenceHash: source.periodEvidenceHash,
        targetSourceKey: banner.sourceKey,
        targetContentHash: jpBannerIdentityTargetHash(
          targetByKey.get(banner.sourceKey)!,
        ),
      };
      const evidence = previewJpBannerIdentityMap(report, baseline, {
        version: 1,
        mappings: [mapping],
      }).mappings[0]!;
      reasons.push(...evidence.issues, ...evidence.registrationHolds);
      const family = banner.family;
      if (!family) reasons.push("NO_EVENT_FAMILY");
      else if (family.events.length > MAX_FAMILY_EVENTS)
        reasons.push("FAMILY_EVENT_BUDGET_EXCEEDED");
      else {
        const primary = stored
          ? family.events.filter((e) => e.id === stored.anchorEventId)
          : family.events.filter((e) => e.type === "MAIN_EVENT");
        const available = stored
          ? primary
          : primary.length
            ? primary
            : family.events.filter((e) =>
                ["CAMPAIGN", "PRE_RELEASE_CAMPAIGN", "QUEST_RELEASE"].includes(
                  e.type,
                ),
              );
        if (available.length !== 1) reasons.push("ANCHOR_NOT_UNIQUE");
        else {
          const event = available[0]!,
            effective = effectiveEvent(event);
          if (
            ![
              "MAIN_EVENT",
              "CAMPAIGN",
              "PRE_RELEASE_CAMPAIGN",
              "QUEST_RELEASE",
            ].includes(event.type) ||
            event.sourceStartsAtPrecision !== "EXACT" ||
            !event.sourceStartsAt ||
            effective.startsAtPrecision !== "EXACT" ||
            eventIsHidden(event)
          )
            reasons.push("EXACT_SOURCE_AND_TARGET_ANCHOR_REQUIRED");
          else {
            const sourceFactsHash = bannerAnchorSourceFactsHash(event);
            if (
              stored?.sourceFactsHash &&
              stored.sourceFactsHash !== sourceFactsHash
            )
              reasons.push("ACCEPTED_ANCHOR_SOURCE_CHANGED");
            const acceptedReference =
              stored?.referenceStartsAt &&
              stored.sourceFactsHash === sourceFactsHash;
            const jpResetDay =
              stored?.jpResetDay.toISOString().slice(0, 10) ??
              jpDay.format(event.sourceStartsAt);
            const naResetDay =
              stored?.naResetDay.toISOString().slice(0, 10) ??
              effective.startsAt.toISOString().slice(0, 10);
            const projected = projectJpBannerBoundary(
              event.sourceStartsAt.toISOString(),
              jpResetDay,
              naResetDay,
              "START",
              jpBannerLaunchHour(event.sourceStartsAt.toISOString()),
            );
            if (
              !acceptedReference &&
              (projected.issues.length ||
                projected.projectedAt !== effective.startsAt.toISOString())
            )
              reasons.push("ANCHOR_RESET_ALIGNMENT_REQUIRES_REVIEW");
            const article = articles.find((a) => a.url === source.sourceUrl);
            const period = article?.inspection?.schedule.periods.find(
              (p) => p.evidenceHash === source.periodEvidenceHash,
            );
            if (
              !period?.startsAt ||
              !period.endsAt ||
              !event.sourceEndsAt ||
              Date.parse(period.endsAt) < event.sourceStartsAt.getTime() ||
              Date.parse(period.startsAt) > event.sourceEndsAt.getTime()
            )
              reasons.push("SOURCE_WINDOW_EVENT_OVERLAP_UNESTABLISHED");
            proposal = {
              mapping,
              anchor: {
                familySourceKey: family.sourceKey,
                eventSourceKey: event.sourceKey,
                jpResetDay,
                naResetDay,
                pickupSourceKeys: [sourceKey],
              },
              sourceFactsHash,
              eventId: event.id,
              metadataOnly: Boolean(owner),
            };
          }
        }
      }
    }
    decisions.push({
      targetSourceKey: row.sourceKey,
      bannerId: banner?.id ?? null,
      familyId: banner?.familyId ?? null,
      status:
        reasons.length || !proposal ? ("HELD" as const) : ("ELIGIBLE" as const),
      reasons: [...new Set(reasons)],
      proposal,
    });
  }
  return {
    report,
    baseline,
    decisions,
    discoveryLimited: reports.some(
      (r) => r.coverageLimited || r.inspectionLimited,
    ),
    inspectedArticles: articles.length,
  };
}

export async function collectJpBannerSources() {
  return [
    await inventoryJpBannerAnnouncements({
      pages: JP_BANNER_INVENTORY_LIMITS.defaultPages,
      inspect: JP_BANNER_INVENTORY_LIMITS.maxArticleInspections,
      resolveServants: true,
      projectNa: true,
    }),
  ];
}
export type JpBannerInitializationReport = {
  status: "success" | "failed";
  examined: number;
  eligible: number;
  registered: number;
  initialized: number;
  unchanged: number;
  inspectedArticles: number;
  discoveryLimited: boolean;
  held: { sourceKey: string; bannerId: string | null; reasons: string[] }[];
  failure?: {
    phase: "COLLECTION" | "QUALIFICATION" | "INITIALIZATION";
    familyId: string | null;
  };
};
type InitializationOptions = {
  collectSources?: typeof collectJpBannerSources;
  dryRun?: boolean;
};
/** Only SOURCE/TIMING of existing banners; new rows, names and rosters are outside this policy. */
export async function syncJpBannerInitialization(
  database: PrismaClient,
  authority: GlobalSourceAuthority,
  baselineInput: unknown,
  asOf: Date,
  options: InitializationOptions = {},
): Promise<JpBannerInitializationReport> {
  await requireSourceAuthority(database, authority);
  const baseline = bannerDatasetSchema.parse(baselineInput);
  const output: JpBannerInitializationReport = {
    status: "success",
    examined: 0,
    eligible: 0,
    registered: 0,
    initialized: 0,
    unchanged: 0,
    inspectedArticles: 0,
    discoveryLimited: false,
    held: [],
  };
  let phase: "COLLECTION" | "QUALIFICATION" | "INITIALIZATION" = "COLLECTION",
    familyId: string | null = null;
  try {
    const reports = await (options.collectSources ?? collectJpBannerSources)();
    phase = "QUALIFICATION";
    const readPlan = (keys?: readonly string[]) =>
      database.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await requireSourceAuthority(tx, authority);
          return planJpBannerInitialization(tx, reports, baseline, asOf, keys);
        },
        {
          isolationLevel: "RepeatableRead",
          timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
        },
      );
    const initial = await readPlan();
    output.examined = initial.decisions.length;
    output.inspectedArticles = initial.inspectedArticles;
    output.discoveryLimited = initial.discoveryLimited;
    const groups = new Map<string, typeof initial.decisions>();
    const hold = (
      row: (typeof initial.decisions)[number],
      reasons = row.reasons,
    ) =>
      output.held.push({
        sourceKey: row.targetSourceKey,
        bannerId: row.bannerId,
        reasons,
      });
    for (const row of initial.decisions) {
      if (row.status === "UNCHANGED") {
        output.unchanged++;
        continue;
      }
      if (row.status === "HELD") {
        hold(row);
        continue;
      }
      output.eligible++;
      const list = groups.get(row.familyId!) ?? [];
      list.push(row);
      groups.set(row.familyId!, list);
    }
    phase = "INITIALIZATION";
    for (const [id, rows] of groups) {
      familyId = id;
      if (rows.length > JP_BANNER_IDENTITY_LIMITS.maxMappings) {
        for (const row of rows) hold(row, ["FAMILY_MAPPING_LIMIT_EXCEEDED"]);
        continue;
      }
      const fresh = await readPlan(rows.map((row) => row.targetSourceKey));
      output.unchanged += fresh.decisions.filter(
        (row) => row.status === "UNCHANGED",
      ).length;
      fresh.decisions = fresh.decisions.filter(
        (row) => row.status !== "UNCHANGED",
      );
      if (!fresh.decisions.length) continue;
      if (fresh.decisions.some((row) => row.status !== "ELIGIBLE")) {
        for (const row of fresh.decisions)
          hold(
            row,
            row.reasons.length ? row.reasons : ["FAMILY_QUALIFICATION_CHANGED"],
          );
        continue;
      }
      // Registration is separate from public-field ownership. A publication hold
      // can leave a valid identity registered, but cannot partially change dates.
      const map = {
        version: 1,
        mappings: fresh.decisions.map((row) => row.proposal!.mapping),
      };
      const identity = await database.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return previewBannerSourceIdentities(tx, fresh.report, baseline, map);
        },
        {
          isolationLevel: "RepeatableRead",
          timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
        },
      );
      if (identity.mappings.some((row) => row.registrationStatus === "HELD")) {
        for (const row of fresh.decisions)
          hold(
            row,
            identity.mappings.find(
              (mapping) => mapping.targetSourceKey === row.targetSourceKey,
            )?.issues ?? ["IDENTITY_REVIEW_REQUIRED"],
          );
        continue;
      }
      if (options.dryRun) {
        continue;
      }
      const registered = await registerBannerSourceIdentities(
        database,
        authority,
        fresh.report,
        baseline,
        {
          version: 1,
          reason:
            "Automatic existing-banner initialization: unique named pickup, exact member set and verified family clock (policy v1)",
          bindings: identity.mappings.map((row) => ({
            ...map.mappings.find(
              (mapping) => mapping.sourceKey === row.sourceKey,
            )!,
            bannerId: row.bannerId!,
            expectedDatabaseFingerprint: row.databaseFingerprint!,
          })),
        },
      );
      output.registered += registered.registered;
      const afterRegistration = await readPlan(
        rows.map((row) => row.targetSourceKey),
      );
      const completedElsewhere = afterRegistration.decisions.filter(
        (row) => row.status === "UNCHANGED",
      );
      if (completedElsewhere.length) {
        output.unchanged += completedElsewhere.length;
        for (const row of afterRegistration.decisions.filter(
          (row) => row.status !== "UNCHANGED",
        ))
          hold(row, ["CONCURRENT_FAMILY_INITIALIZATION"]);
        continue;
      }
      if (
        afterRegistration.decisions.some(
          (row) =>
            row.status !== "ELIGIBLE" ||
            row.proposal!.sourceFactsHash !==
              fresh.decisions.find(
                (old) => old.targetSourceKey === row.targetSourceKey,
              )!.proposal!.sourceFactsHash,
        )
      ) {
        for (const row of afterRegistration.decisions)
          hold(row, ["FAMILY_QUALIFICATION_CHANGED"]);
        continue;
      }
      const anchor = afterRegistration.decisions[0]!.proposal!.anchor;
      const anchors = {
        version: 1,
        anchors: [
          {
            ...anchor,
            pickupSourceKeys: afterRegistration.decisions.map(
              (row) => row.proposal!.mapping.sourceKey,
            ),
          },
        ],
      };
      const review = await database.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const preview = await previewBannerSourcePublication(
            tx,
            afterRegistration.report,
            baseline,
            map,
            ["SOURCE", "TIMING"],
            anchors,
            authority,
          );
          const timing = await loadJpBannerFamilyTiming(
            tx,
            afterRegistration.report,
            previewJpBannerIdentityMap(afterRegistration.report, baseline, map),
            anchors,
            true,
          );
          return { preview, timing };
        },
        {
          isolationLevel: "RepeatableRead",
          timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
        },
      );
      const held = review.preview.mappings.filter(
        (row) =>
          row.status === "HELD" ||
          (afterRegistration.decisions.find(
            (item) => item.bannerId === row.bannerId,
          )!.proposal!.metadataOnly &&
            JSON.stringify(row.currentValues) !==
              JSON.stringify(row.proposedValues)) ||
          review.timing.mappings.some(
            (t) =>
              t.storedAnchor &&
              !t.storedAnchor.referenceStartsAt &&
              t.anchorFactsHash !== t.storedAnchor.factsHash,
          ),
      );
      if (held.length) {
        for (const row of afterRegistration.decisions)
          hold(row, [
            ...new Set(
              held.flatMap((item) =>
                item.issues.length
                  ? item.issues
                  : ["EXISTING_REVIEWED_TIMING_CHANGED"],
              ),
            ),
          ]);
        continue;
      }
      const publication = await publishBannerSourceValues(
        database,
        authority,
        afterRegistration.report,
        baseline,
        {
          version: 1,
          reason:
            "Automatic SOURCE/TIMING initialization from unique named pickup and exact existing event anchor (policy v1)",
          familyAnchors: anchors,
          bindings: review.preview.mappings.map((row) => ({
            ...map.mappings.find(
              (mapping) => mapping.sourceKey === row.sourceKey,
            )!,
            bannerId: row.bannerId!,
            expectedDatabaseFingerprint: row.databaseFingerprint!,
            fields: row.fields,
            expectedPublicationRevision: row.publicationRevision,
            timing: row.timing,
          })),
        },
      );
      output.initialized += publication.published;
      output.unchanged += publication.unchanged;
    }
    return output;
  } catch {
    return { ...output, status: "failed", failure: { phase, familyId } };
  }
}
