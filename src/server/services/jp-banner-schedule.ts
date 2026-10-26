import { createHash } from "node:crypto";
import { GLOBAL_CAMPAIGN_IDENTITY_LIMITS } from "../../shared/global-reconciliation-config";

type ScheduleSource = {
  sourceUrl: string;
  title: string | null;
  blocks: readonly string[];
  images: readonly { url: string; alt: string; context: string }[];
  summonContent: boolean;
  evidenceComplete: boolean;
};
type PeriodScope =
  "ARTICLE_ENVELOPE" | "LABELLED_SUMMON" | "OTHER_PERIOD" | "UNLABELLED";
type PeriodCandidate = {
  evidenceHash: string;
  scope: PeriodScope;
  subject: string | null;
  label: string;
  context: string;
  normalizedPeriod: string;
  startsAt: string | null;
  endsAt: string | null;
  timezone: "JST" | null;
  timezoneBasis: "EXPLICIT_JST" | "JP_PUBLISHER_CONVENTION" | "UNSUPPORTED";
  endYearBasis: "EXPLICIT" | "SAME_YEAR" | "ROLLOVER";
  issues: string[];
};

// These are displayed source minutes, not exclusive ends or projected NA times.
const RANGE =
  /(?<!\d)(?<sy>20\d{2})年\s*(?<sm>\d{1,2})月\s*(?<sd>\d{1,2})日(?:\s*\([^)]{1,12}\))?(?:\s*(?<sh>\d{1,2}):(?<sn>\d{2})(?::(?<ss>\d{2}))?)?\s*[~～〜–—-]\s*(?:(?<ey>20\d{2})年\s*)?(?<em>\d{1,2})月\s*(?<ed>\d{1,2})日(?:\s*\([^)]{1,12}\))?(?:\s*(?<eh>\d{1,2}):(?<en>\d{2})(?::(?<es>\d{2}))?)?(?![\d:])/gu;
const SUMMON = /召喚|ピックアップ|summon|pick[\s-]?up/iu;
const PERIOD_LABEL = /期間|日時|日程|period/iu;
const FOREIGN_ZONE = /\b(?:UTC|GMT|PDT|PST|EST|EDT|CST|CDT|CET|CEST|KST)\b/iu;
const hash = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const fold = (value: string) =>
  value.normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "");

function quotedSubject(label: string) {
  const stack: string[] = [];
  let start = -1;
  for (let index = 0; index < label.length; index++) {
    const char = label[index]!;
    if (char === "「" || char === "『") {
      if (!stack.length) start = index;
      stack.push(char === "「" ? "」" : "』");
    } else if (char === "」" || char === "』") {
      if (stack.pop() !== char) return null;
      if (!stack.length && start >= 0)
        return label.slice(start + 1, index).trim() || null;
    }
  }
  return null;
}

function scopeFor(
  label: string,
  subject: string | null,
  title: string | null,
): PeriodScope {
  if (
    /(?:交換|クエスト|ミッション|ログイン|受取|配布|メンテナンス|放送|イベント)(?:の)?(?:開催)?(?:期間|日時|日程)/u.test(
      label,
    )
  )
    return "OTHER_PERIOD";
  if (!SUMMON.test(label) || !PERIOD_LABEL.test(label)) return "UNLABELLED";
  return subject && !fold(title ?? "").includes(fold(subject))
    ? "LABELLED_SUMMON"
    : "ARTICLE_ENVELOPE";
}

function jst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute
  )
    return null;
  return new Date(
    local.getTime() - GLOBAL_CAMPAIGN_IDENTITY_LIMITS.jstOffsetMinutes * 60_000,
  ).toISOString();
}

function pickupRosterList(context: string, sourceUrl: string) {
  const normalized = context.normalize("NFKC").trim();
  const header =
    /^【ピックアップ対象】\s*▼(期間限定|ストーリー召喚|恒常)?サーヴァント(?=\s|・|$)/u.exec(
      normalized,
    );
  if (!header) return null;
  const issues: string[] = [];
  const evidenceHash = hash([sourceUrl, "PICKUP_ROSTER_LIST", normalized]);
  const members: { name: string; rarity: number; evidenceHash: string }[] = [];
  const labels: Record<string, number> = { SSR: 5, SR: 4, R: 3, UC: 2, C: 1 };
  const pieces = normalized
    .slice(header[0].length)
    .split(/(?=・\s*[★☆])/u)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (!pieces.length) issues.push("EMPTY_PICKUP_ROSTER_LIST");
  for (const piece of pieces) {
    const item =
      /^・\s*[★☆]\s*([0-5])\s*(?:\((SSR|SR|R|UC|C)\))?\s*([^。※▼◆◇「」『』]{1,120})$/u.exec(
        piece,
      );
    if (!item) {
      issues.push("UNSUPPORTED_PICKUP_ROSTER_ITEM");
      continue;
    }
    const rarity = Number(item[1]),
      name = item[3]!.trim();
    if (item[2] && labels[item[2]] !== rarity)
      issues.push("ROSTER_RARITY_LABEL_MISMATCH");
    if (!name || /^\((?:SSR|SR|R|UC|C)\)$/u.test(name))
      issues.push("EMPTY_PICKUP_ROSTER_NAME");
    if (
      members.some((member) => member.rarity === rarity && member.name === name)
    )
      issues.push("DUPLICATE_PICKUP_ROSTER_ITEM");
    members.push({
      name,
      rarity,
      evidenceHash: hash([
        sourceUrl,
        "PICKUP_LIST_MEMBER",
        evidenceHash,
        name,
        rarity,
      ]),
    });
  }
  return {
    evidenceHash,
    context,
    members,
    issues: [...new Set(issues)],
    subset:
      header[1] === "期間限定"
        ? ("LIMITED" as const)
        : header[1] === "ストーリー召喚"
          ? ("STORY" as const)
          : header[1] === "恒常"
            ? ("PERMANENT" as const)
            : ("UNQUALIFIED" as const),
  };
}

export function extractJpBannerSchedule(source: ScheduleSource) {
  if (
    source.blocks.length > 80 ||
    source.blocks.some((block) => block.length > 4_000)
  )
    throw new Error("JP schedule evidence exceeds the extraction limit.");
  const periods: PeriodCandidate[] = [];
  const unparsedPeriods: { context: string; reason: string }[] = [];
  const servantMentions: {
    name: string;
    rarity: number;
    context: string;
    evidenceHash: string;
  }[] = [];
  const summonGroupEvidence: {
    pickupCount: number;
    declaredServantCount: number | null;
    context: string;
    evidenceHash: string;
  }[] = [];
  const pickupRosterLists: NonNullable<ReturnType<typeof pickupRosterList>>[] =
    [];
  let explicitSeparatePeriods = false;
  for (const context of source.blocks) {
    const normalized = context.normalize("NFKC");
    const roster = pickupRosterList(context, source.sourceUrl);
    if (
      roster &&
      !pickupRosterLists.some(
        (list) => list.evidenceHash === roster.evidenceHash,
      )
    ) {
      pickupRosterLists.push(roster);
      if (!roster.issues.length)
        for (const member of roster.members)
          servantMentions.push({ ...member, context });
    }
    // Conditional instructions describe game rules, not this notice's actual schedule.
    const declaration = normalized.replace(/\s+/gu, "");
    if (!/場合|一例|例として|たとえば/u.test(declaration)) {
      if (
        /それぞれのピックアップ召喚は[、,]*開催期間が異なります|召喚内容ごとに個別の召喚として開催(?:される仕様|されます|いたします|します)/u.test(
          declaration,
        )
      )
        explicitSeparatePeriods = true;
      const count = /(?<!\d)(\d{1,3})種類の召喚/u.exec(declaration);
      if (
        count &&
        Number(count[1]) > 0 &&
        /種類の召喚を?開催(?:いたします|します|[!。]|$)/u.test(declaration)
      ) {
        const evidenceHash = hash([
          source.sourceUrl,
          "SUMMON_GROUP",
          normalized,
        ]);
        const servants = /(?<!\d)(\d{1,3})騎(?:と|のサーヴァント)/u.exec(
          declaration.slice(0, count.index),
        );
        if (
          !summonGroupEvidence.some(
            (group) => group.evidenceHash === evidenceHash,
          )
        )
          summonGroupEvidence.push({
            pickupCount: Number(count[1]),
            declaredServantCount: servants ? Number(servants[1]) : null,
            context,
            evidenceHash,
          });
      }
    }
    const matches = [...normalized.matchAll(RANGE)];
    if (
      !matches.length &&
      SUMMON.test(normalized) &&
      PERIOD_LABEL.test(normalized) &&
      /\d.*[~～〜–—-]/u.test(normalized)
    )
      unparsedPeriods.push({ context, reason: "UNSUPPORTED_DATE_FORMAT" });
    for (const match of matches) {
      const groups = match.groups!;
      const label = normalized.slice(0, match.index).trim();
      const subject = quotedSubject(label);
      const scope = scopeFor(label, subject, source.title);
      const issues: string[] = [];
      const startYear = Number(groups.sy);
      const rollover = !groups.ey && Number(groups.em) < Number(groups.sm);
      const endYear = groups.ey
        ? Number(groups.ey)
        : startYear + Number(rollover);
      const foreign = FOREIGN_ZONE.test(normalized);
      if (foreign) issues.push("UNSUPPORTED_TIMEZONE");
      if (!groups.sh || !groups.sn || !groups.eh || !groups.en)
        issues.push("TIME_MISSING");
      if (groups.ss || groups.es) issues.push("UNSUPPORTED_TIME_PRECISION");
      let startsAt = jst(
        startYear,
        Number(groups.sm),
        Number(groups.sd),
        Number(groups.sh),
        Number(groups.sn),
      );
      let endsAt = jst(
        endYear,
        Number(groups.em),
        Number(groups.ed),
        Number(groups.eh),
        Number(groups.en),
      );
      if (!startsAt || !endsAt) issues.push("INVALID_DATE_OR_TIME");
      if (startsAt && endsAt && endsAt < startsAt)
        issues.push("REVERSED_PERIOD");
      if (scope === "UNLABELLED") issues.push("SUBJECT_LABEL_MISSING");
      if (matches.length > 1) issues.push("MULTIPLE_RANGES_UNDER_LABEL");
      if (
        issues.some(
          (issue) =>
            !["SUBJECT_LABEL_MISSING", "MULTIPLE_RANGES_UNDER_LABEL"].includes(
              issue,
            ),
        )
      ) {
        startsAt = null;
        endsAt = null;
      }
      // Evidence hashes identify extracted facts, never persistent banner identities.
      const evidenceHash = hash([
        source.sourceUrl,
        scope,
        subject,
        label,
        match[0],
      ]);
      if (!periods.some((period) => period.evidenceHash === evidenceHash))
        periods.push({
          evidenceHash,
          scope,
          subject,
          label,
          context,
          normalizedPeriod: match[0],
          startsAt,
          endsAt,
          timezone: foreign ? null : "JST",
          timezoneBasis: foreign
            ? "UNSUPPORTED"
            : /\bJST\b|日本時間/u.test(normalized)
              ? "EXPLICIT_JST"
              : "JP_PUBLISHER_CONVENTION",
          endYearBasis: groups.ey
            ? "EXPLICIT"
            : rollover
              ? "ROLLOVER"
              : "SAME_YEAR",
          issues,
        });
    }
    if (
      !normalized.trimStart().startsWith("【ピックアップ対象】") &&
      normalized.includes("サーヴァント") &&
      normalized.includes("ピックアップ")
    ) {
      for (const match of normalized.matchAll(
        /[「『]\s*[★☆]\s*([0-5])\s*(?:\((?:SSR|SR|R|UC|C)\))?\s*([^「」『』]{1,120})[」』]/gu,
      )) {
        const roles = [
          ...normalized
            .slice(0, match.index)
            .matchAll(/サーヴァント|概念礼装/gu),
        ];
        if (roles.at(-1)?.[0] !== "サーヴァント") continue;
        const name = match[2]!.trim(),
          rarity = Number(match[1]);
        const evidenceHash = hash([source.sourceUrl, name, rarity, normalized]);
        if (
          !servantMentions.some(
            (mention) => mention.evidenceHash === evidenceHash,
          )
        )
          servantMentions.push({ name, rarity, context, evidenceHash });
      }
    }
  }
  const subjectPeriods = new Map<string, PeriodCandidate[]>();
  for (const period of periods) {
    if (
      period.scope !== "ARTICLE_ENVELOPE" &&
      period.scope !== "LABELLED_SUMMON"
    )
      continue;
    const key = `${period.scope}:${fold(period.subject ?? period.label)}`;
    const group = subjectPeriods.get(key) ?? [];
    group.push(period);
    subjectPeriods.set(key, group);
  }
  for (const group of subjectPeriods.values()) {
    if (
      new Set(group.map((period) => `${period.startsAt}:${period.endsAt}`))
        .size > 1
    )
      for (const period of group)
        period.issues.push("CONFLICTING_SUBJECT_PERIODS");
  }
  const scheduleImageCandidates = source.images.filter((image) =>
    /スケジュール|日程|schedule/iu.test(`${image.alt} ${image.context}`),
  );
  const pendingEvidence: string[] = [];
  if (pickupRosterLists.some((list) => list.issues.length))
    pendingEvidence.push("PICKUP_ROSTER_LIST_UNRESOLVED");
  if (source.summonContent) {
    if (
      !periods.some(
        (period) =>
          ["ARTICLE_ENVELOPE", "LABELLED_SUMMON"].includes(period.scope) &&
          !period.issues.length,
      )
    )
      pendingEvidence.push("NO_VALID_LABELLED_SUMMON_PERIOD");
    if (scheduleImageCandidates.length)
      pendingEvidence.push("IMAGE_SCHEDULE_UNINTERPRETED");
    if (
      explicitSeparatePeriods ||
      summonGroupEvidence.some((group) => group.pickupCount > 1)
    )
      pendingEvidence.push("INDIVIDUAL_PICKUP_WINDOWS_UNRESOLVED");
    pendingEvidence.push(
      "ROSTER_IDENTITY_UNRESOLVED",
      "WINDOW_ROSTER_BINDING_UNRESOLVED",
    );
  }
  if (!source.evidenceComplete)
    pendingEvidence.push("INCOMPLETE_ARTICLE_EVIDENCE");
  return {
    periods,
    unparsedPeriods,
    servantMentions,
    pickupRosterLists,
    summonGroupEvidence,
    scheduleImageCandidates,
    pendingEvidence,
    publicationAllowed: false as const,
  };
}
