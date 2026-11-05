import { createHash } from "node:crypto";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";

type Report = Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>;
type Inspection = NonNullable<Report["articles"][number]["inspection"]>;

/** Classify only demonstrably non-roster prose; preserve the original schedule diagnostics. */
function nonRosterPeriodReason(context: string) {
  const text = context.normalize("NFKC").replace(/\s+/gu, "");
  if (
    /^[◆◇]*概念礼装に関するご注意[◆◇]/u.test(text) &&
    !/サーヴァント|ピックアップ召喚|召喚(?:の)?期間|(?:開催|実施)(?:期間|日時)|スケジュール/u.test(
      text,
    )
  )
    return "CRAFT_ESSENCE_NOTES" as const;
  const prose = text.replace(/期間限定|ピックアップ期間中/gu, "");
  if (
    text.startsWith("期間限定イベント") &&
    text.includes("ピックアップ") &&
    !/\d+(?:年|月|日|時|分|秒|[:：/／-])|期間|日時|日程|開催日|開始|終了|締切|翌日|明日|当日|毎日|後日|本日|正午|午前|午後|週|スケジュール|予定/u.test(
      prose,
    )
  )
    return "NO_SCHEDULE_EXPRESSION" as const;
  return null;
}

/** Source-only proposal. Standard rate rules still require explicit reviewer acceptance. */
export function previewJpBannerRoster(
  report: Report,
  inspection: Inspection | null | undefined,
  periodEvidenceHash: string,
) {
  const issues: string[] = [];
  const windows = inspection?.pickupEvidence?.windows ?? [];
  const window = windows.find(
    (row) => row.periodEvidenceHash === periodEvidenceHash,
  );
  const lists = inspection?.schedule.pickupRosterLists ?? [];
  const list = lists.length === 1 ? lists[0] : undefined;
  const period = inspection?.schedule.periods.find(
    (row) => row.evidenceHash === periodEvidenceHash,
  );
  if (
    !period ||
    /場合|一例|例として|たとえば|例えば/u.test(
      period.context + (list?.context ?? ""),
    )
  )
    issues.push("ROSTER_PICKUP_SCOPE_UNSUPPORTED");
  if (inspection?.kind !== "SUMMON_CONTENT" || inspection.restrictionEvidence)
    issues.push("ROSTER_SOURCE_NOT_ELIGIBLE");
  if (windows.length !== 1 || !window)
    issues.push("SINGLE_PICKUP_WINDOW_REQUIRED");
  if (!list) issues.push("PICKUP_ROSTER_LIST_NOT_UNIQUE");
  issues.push(...(list?.issues ?? []), ...(window?.issues ?? []));
  for (const issue of inspection?.schedule.pendingEvidence ?? [])
    if (
      [
        "INCOMPLETE_ARTICLE_EVIDENCE",
        "INDIVIDUAL_PICKUP_WINDOWS_UNRESOLVED",
        "IMAGE_SCHEDULE_UNINTERPRETED",
      ].includes(issue)
    )
      issues.push(issue);
  const nonRosterPeriodEvidence = (
    inspection?.schedule.unparsedPeriods ?? []
  ).flatMap((row) => {
    const reason = nonRosterPeriodReason(row.context);
    return reason ? [{ context: row.context, reason }] : [];
  });
  if (
    (inspection?.schedule.unparsedPeriods.length ?? 0) !==
    nonRosterPeriodEvidence.length
  )
    issues.push("UNPARSED_PERIOD_EVIDENCE");
  if (
    report.servantCatalogue?.status !== "SUCCEEDED" ||
    !report.servantCatalogue?.contentHash
  )
    issues.push("ROSTER_CATALOGUE_UNAVAILABLE");

  const members = (list?.members ?? [])
    .flatMap((member) => {
      const associations =
        window?.associations.filter(
          (row) =>
            row.mentionEvidenceHashes.includes(member.evidenceHash) &&
            row.rosterListEvidenceHashes.includes(list!.evidenceHash),
        ) ?? [];
      if (associations.length !== 1) {
        issues.push("ROSTER_LIST_MEMBER_NOT_BOUND_TO_PICKUP");
        return [];
      }
      const association = associations[0]!;
      const identity = inspection?.servantIdentities?.find(
        (row) => row.evidenceHash === member.evidenceHash,
      );
      const candidate = identity?.candidates.find(
        (row) => row.servantId === association.servantId,
      );
      if (
        identity?.status !== "MATCHED" ||
        identity.servantId !== association.servantId ||
        candidate?.rarity !== member.rarity
      ) {
        issues.push("ROSTER_CATALOGUE_IDENTITY_UNRESOLVED");
        return [];
      }
      return [
        {
          servantId: association.servantId,
          rarity: member.rarity,
          className: candidate.className,
        },
      ];
    })
    .sort((a, b) => a.servantId - b.servantId);
  if (!members.length) issues.push("EMPTY_PICKUP_ROSTER");
  if (
    new Set(members.map((member) => member.servantId)).size !== members.length
  )
    issues.push("DUPLICATE_ROSTER_IDENTITY");
  if (
    JSON.stringify(members.map((member) => member.servantId)) !==
    JSON.stringify(
      [...(window?.associations.map((member) => member.servantId) ?? [])].sort(
        (a, b) => a - b,
      ),
    )
  )
    issues.push("ROSTER_LIST_WINDOW_MEMBERS_DIFFER");
  // An independently parsed declaration must agree; never ignore contradictory totals.
  if (
    inspection?.schedule.pickupRosterDeclarations.length &&
    window?.countedRosterReview.status !== "CONSISTENT_REVIEW_REQUIRED"
  )
    issues.push("COUNTED_ROSTER_EVIDENCE_CONFLICT");
  const counts = new Map<number, number>();
  for (const member of members)
    counts.set(member.rarity, (counts.get(member.rarity) ?? 0) + 1);
  // Only the ordinary one-SSR, up-to-three-SR, one-R format is supported here.
  if (
    (counts.get(5) ?? 0) !== 1 ||
    (counts.get(4) ?? 0) > 3 ||
    (counts.get(3) ?? 0) > 1 ||
    members.some((member) => ![3, 4, 5].includes(member.rarity))
  )
    issues.push("ROSTER_RATE_FORMAT_UNSUPPORTED");
  const featured = members.map((member) => ({
    ...member,
    soloRateUp: counts.get(member.rarity) === 1,
  }));
  const evidenceHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        articleContentHash: inspection?.contentHash ?? null,
        periodEvidenceHash,
        listEvidenceHash: list?.evidenceHash ?? null,
        catalogueContentHash: report.servantCatalogue?.contentHash ?? null,
        rateRule: "STANDARD_RATE_UP",
        featured,
      }),
    )
    .digest("hex");
  return {
    status: issues.length
      ? ("HELD" as const)
      : ("REQUIRES_ROSTER_REVIEW" as const),
    issues: [...new Set(issues)],
    evidenceHash,
    listEvidenceHash: list?.evidenceHash ?? null,
    catalogueContentHash: report.servantCatalogue?.contentHash ?? null,
    nonRosterPeriodEvidence,
    rateRule: "STANDARD_RATE_UP" as const,
    featured,
    publicationAllowed: false as const,
  };
}
