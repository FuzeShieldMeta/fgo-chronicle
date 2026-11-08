import type { Prisma, PrismaClient } from "../../../generated/prisma";
import { GLOBAL_SOURCE_LIMITS } from "~/shared/global-reconciliation-config";
import { JP_BANNER_AUDIT_LIMITS } from "./jp-banner-audit";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { previewJpBannerRoster } from "./jp-banner-roster";

type SourceReport = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
export const JP_BANNER_DISCOVERY_LIMITS = {
  pageSize: 200,
  maxBanners: 10_000,
  maxMembersPerBanner: 600,
  maxIdentitiesPerBanner: 200,
} as const;
const selection = {
  id: true,
  sourceKey: true,
  sourceUrl: true,
  name: true,
  startsAt: true,
  endsAt: true,
  familyId: true,
  hidden: true,
  status: true,
  sourceRegion: true,
  dateOverlay: { select: { bannerId: true } },
  family: { select: { curation: { select: { active: true } } } },
  _count: { select: { summonLineups: true } },
  featured: {
    select: { servantId: true },
    orderBy: { servantId: "asc" },
    take: JP_BANNER_DISCOVERY_LIMITS.maxMembersPerBanner + 1,
  },
  sourceIdentities: {
    select: {
      sourceKey: true,
      sourceUrl: true,
      articleContentHash: true,
      periodEvidenceHash: true,
    },
    orderBy: { sourceKey: "asc" },
    take: JP_BANNER_DISCOVERY_LIMITS.maxIdentitiesPerBanner + 1,
  },
} satisfies Prisma.BannerSelect;
type Target = Prisma.BannerGetPayload<{ select: typeof selection }>;
const DAY_MS = 86_400_000;

/** Review hints only. Neither overlap nor an empty result authorises identity or creation. */
export function discoverJpBannerTargets(
  reports: readonly SourceReport[],
  targets: readonly Target[],
) {
  const articles = reports.flatMap((report) => report.articles);
  if (
    !reports.length ||
    reports.some(
      (report) =>
        report.status !== "succeeded" || report.articleFailures.length,
    ) ||
    reports.some(
      (report) =>
        report.servantCatalogue.status !== "SUCCEEDED" ||
        !report.servantCatalogue.contentHash,
    ) ||
    new Set(reports.map((report) => report.servantCatalogue.contentHash))
      .size !== 1 ||
    new Set(articles.map((article) => article.url)).size !== articles.length ||
    articles.length > JP_BANNER_AUDIT_LIMITS.maxNotices
  )
    throw new Error(
      "JP discovery requires complete, distinct inspected source reports and one catalogue.",
    );
  if (
    targets.length > JP_BANNER_DISCOVERY_LIMITS.maxBanners ||
    new Set(targets.map((target) => target.id)).size !== targets.length ||
    targets.some(
      (target) =>
        target.featured.length >
          JP_BANNER_DISCOVERY_LIMITS.maxMembersPerBanner ||
        target.sourceIdentities.length >
          JP_BANNER_DISCOVERY_LIMITS.maxIdentitiesPerBanner,
    )
  )
    throw new Error(
      "JP discovery target inventory is incomplete or exceeds its budget.",
    );

  const describe = (target: Target) => ({
    bannerId: target.id,
    // Legacy keys are opaque: do not reconstruct them from current names or dates.
    targetSourceKey: target.sourceKey,
    name: target.name,
    familyId: target.familyId,
    servantIds: target.featured.map((member) => member.servantId),
    protected:
      target.hidden ||
      target.status !== "PROJECTED" ||
      target.sourceRegion !== "JP_PROJECTED" ||
      Boolean(target.dateOverlay) ||
      Boolean(target.family?.curation?.active) ||
      target._count.summonLineups > 0,
  });
  const byNotice = new Map<string, Set<Target>>();
  const byServant = new Map<number, Set<Target>>();
  const add = <Key>(index: Map<Key, Set<Target>>, key: Key, target: Target) => {
    const entries = index.get(key) ?? new Set<Target>();
    entries.add(target);
    index.set(key, entries);
  };
  for (const target of targets) {
    if (target.sourceUrl) add(byNotice, target.sourceUrl, target);
    for (const identity of target.sourceIdentities)
      add(byNotice, identity.sourceUrl, target);
    for (const member of target.featured)
      add(byServant, member.servantId, target);
  }
  const windowCount = articles.reduce(
    (count, article) =>
      count + (article.inspection?.pickupEvidence?.windows.length ?? 0),
    0,
  );
  if (windowCount > JP_BANNER_AUDIT_LIMITS.maxWindows)
    throw new Error("JP discovery window budget exceeded.");
  let candidateCount = 0;
  const decisions = reports.flatMap((report) =>
    report.articles.flatMap((article) => {
      const inspection = article.inspection;
      if (!inspection) return [];
      return (inspection.pickupEvidence?.windows ?? []).map((window) => {
        const roster = previewJpBannerRoster(
          report,
          inspection,
          window.periodEvidenceHash,
        );
        const period = inspection.schedule.periods.find(
          (row) => row.evidenceHash === window.periodEvidenceHash,
        );
        const projection = inspection.naProjection?.windows.find(
          (row) => row.periodEvidenceHash === window.periodEvidenceHash,
        );
        const sourceIds = new Set(
          roster.featured.map((member) => member.servantId),
        );
        const relatedNoticeTargets = [...(byNotice.get(article.url) ?? [])];
        const noticeBindings = relatedNoticeTargets.filter((target) =>
          target.sourceIdentities.some(
            (identity) => identity.sourceUrl === article.url,
          ),
        );
        const exactBindings = noticeBindings.filter((target) =>
          target.sourceIdentities.some(
            (identity) =>
              identity.sourceUrl === article.url &&
              identity.periodEvidenceHash === window.periodEvidenceHash,
          ),
        );
        const matchingIdentities = exactBindings.flatMap((target) =>
          target.sourceIdentities.filter(
            (identity) =>
              identity.sourceUrl === article.url &&
              identity.periodEvidenceHash === window.periodEvidenceHash,
          ),
        );
        const potential = new Set(relatedNoticeTargets);
        for (const id of sourceIds)
          for (const target of byServant.get(id) ?? []) potential.add(target);
        const candidates = [...potential]
          .sort((a, b) => a.id.localeCompare(b.id))
          .flatMap((target) => {
            const hints: string[] = [];
            if (noticeBindings.includes(target))
              hints.push("REGISTERED_NOTICE");
            if (target.sourceUrl === article.url)
              hints.push("EXISTING_SOURCE_URL");
            if (
              projection?.status === "PROJECTED" &&
              projection.projectedStartsAt &&
              projection.projectedEndsAt
            ) {
              const start = Date.parse(projection.projectedStartsAt),
                end = Date.parse(projection.projectedEndsAt);
              const nearby =
                Math.abs(target.startsAt.getTime() - start) <=
                JP_BANNER_AUDIT_LIMITS.nearbyCalendarDays * DAY_MS;
              const overlaps =
                target.startsAt.getTime() <= end &&
                (!target.endsAt || target.endsAt.getTime() >= start);
              if (
                (nearby || overlaps) &&
                target.featured.some((member) =>
                  sourceIds.has(member.servantId),
                )
              )
                hints.push("SERVANT_AND_ESTIMATED_WINDOW_OVERLAP");
            }
            return hints.length ? [{ ...describe(target), hints }] : [];
          });
        candidateCount += candidates.length;
        if (candidateCount > JP_BANNER_AUDIT_LIMITS.maxPairs)
          throw new Error("JP discovery candidate budget exceeded.");
        const reasons = [...roster.issues];
        if (matchingIdentities.length > 1)
          reasons.push("MULTIPLE_REGISTERED_IDENTITIES");
        if (
          matchingIdentities.some(
            (identity) =>
              identity.articleContentHash !== inspection.contentHash,
          )
        )
          reasons.push("REGISTERED_ARTICLE_EVIDENCE_CHANGED");
        if (!exactBindings.length && noticeBindings.length)
          reasons.push("REGISTERED_NOTICE_REQUIRES_REVIEW");
        const registered = matchingIdentities.length === 1 && !reasons.length;
        return {
          sourceUrl: article.url,
          articleContentHash: inspection.contentHash,
          periodEvidenceHash: window.periodEvidenceHash,
          sourceStartsAt: period?.startsAt ?? null,
          sourceEndsAt: period?.endsAt ?? null,
          roster,
          registeredTargets: exactBindings.map(describe),
          candidates,
          status:
            roster.status === "HELD"
              ? ("SOURCE_HELD" as const)
              : registered
                ? ("REGISTERED" as const)
                : noticeBindings.length
                  ? ("REGISTERED_EVIDENCE_REQUIRES_REVIEW" as const)
                  : candidates.length
                    ? ("EXISTING_TARGET_REQUIRES_REVIEW" as const)
                    : ("UNMATCHED_REQUIRES_REVIEW" as const),
          reasons: [...new Set(reasons)],
          identityConfirmed: false as const,
          creationAllowed: false as const,
          publicationAllowed: false as const,
        };
      });
    }),
  );
  if (decisions.length > JP_BANNER_AUDIT_LIMITS.maxWindows)
    throw new Error("JP discovery window budget exceeded.");
  return {
    scope: "JP_BANNER_DATABASE_DISCOVERY" as const,
    examinedBanners: targets.length,
    inspectedArticles: articles.filter((article) => article.inspection).length,
    discoveryLimited: reports.some(
      (report) => report.coverageLimited || report.inspectionLimited,
    ),
    unsupportedHtmlSections: articles.flatMap((article) =>
      (article.inspection?.htmlPickupSections.sections ?? []).map(
        (section) => ({
          sourceUrl: article.url,
          sectionId: section.sectionId,
          reason: "HTML_SECTION_REGISTRATION_UNSUPPORTED" as const,
        }),
      ),
    ),
    // Complete target enumeration is not proof of complete source coverage or safe creation.
    decisions,
    databaseWrites: 0 as const,
    creationAllowed: false as const,
    publicationAllowed: false as const,
  };
}

/** Enumerate current targets, including hidden/official/curated rows, in one read-only snapshot. */
export async function previewJpBannerDatabaseDiscovery(
  database: PrismaClient,
  reports: readonly SourceReport[],
) {
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const targets: Target[] = [];
      let lastId: string | undefined;
      for (;;) {
        const page = await tx.banner.findMany({
          where: lastId ? { id: { gt: lastId } } : {},
          orderBy: { id: "asc" },
          take: Math.min(
            JP_BANNER_DISCOVERY_LIMITS.pageSize,
            JP_BANNER_DISCOVERY_LIMITS.maxBanners - targets.length + 1,
          ),
          select: selection,
        });
        targets.push(...page);
        if (targets.length > JP_BANNER_DISCOVERY_LIMITS.maxBanners)
          throw new Error("JP discovery database inventory budget exceeded.");
        if (!page.length) break;
        lastId = page[page.length - 1]!.id;
      }
      return discoverJpBannerTargets(reports, targets);
    },
    {
      isolationLevel: "RepeatableRead",
      timeout: GLOBAL_SOURCE_LIMITS.transactionTimeoutMs,
    },
  );
}
