import { createHash } from "node:crypto";
import type { extractJpBannerSchedule } from "./jp-banner-schedule";

export const JP_BANNER_SERVANT_SOURCE =
  "https://api.atlasacademy.io/export/JP/basic_servant.json";
const MAX_BYTES = 8 * 1_024 * 1_024;
const MAX_RECORDS = 2_000;
const MAX_NAME = 200;
// Only recognized class labels may qualify a name; other variant suffixes stay intact.
const CLASS_SUFFIXES = new Map([
  ["セイバー", "saber"],
  ["アーチャー", "archer"],
  ["ランサー", "lancer"],
  ["ライダー", "rider"],
  ["キャスター", "caster"],
  ["アサシン", "assassin"],
  ["バーサーカー", "berserker"],
]);

type Servant = {
  collectionNo: number;
  name: string;
  originalName: string;
  rarity: number;
  className: string;
};
type Mention = {
  name: string;
  rarity: number;
  context: string;
  evidenceHash: string;
};
const normalize = (name: string) =>
  name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export function parseJpBannerServantCatalogue(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RECORDS)
    throw new Error("Unsupported JP servant catalogue size.");
  const servants: Servant[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object")
      throw new Error("Unsupported JP servant catalogue record.");
    const row = item as Record<string, unknown>;
    if (row.collectionNo === 0) continue;
    if (
      typeof row.collectionNo !== "number" ||
      !Number.isSafeInteger(row.collectionNo) ||
      row.collectionNo < 1 ||
      row.collectionNo > 2_147_483_647 ||
      typeof row.rarity !== "number" ||
      !Number.isInteger(row.rarity) ||
      row.rarity < 0 ||
      row.rarity > 5 ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > MAX_NAME ||
      typeof row.originalName !== "string" ||
      !row.originalName.trim() ||
      row.originalName.length > MAX_NAME ||
      typeof row.className !== "string" ||
      !/^[a-zA-Z]{1,40}$/.test(row.className)
    )
      throw new Error("Unsupported JP servant catalogue fields.");
    const existing = servants.find(
      (servant) => servant.collectionNo === row.collectionNo,
    );
    if (
      existing &&
      (existing.rarity !== row.rarity || existing.className !== row.className)
    )
      throw new Error("Conflicting JP servant catalogue identity.");
    servants.push({
      collectionNo: row.collectionNo,
      name: row.name.trim(),
      originalName: row.originalName.trim(),
      rarity: row.rarity,
      className: row.className,
    });
  }
  if (!servants.length) throw new Error("Empty JP servant identity catalogue.");
  return servants;
}

export async function fetchJpBannerServantCatalogue(
  fetchFn: typeof fetch = fetch,
  parentSignal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(15_000);
  const signal = parentSignal
    ? AbortSignal.any([timeout, parentSignal])
    : timeout;
  const response = await fetchFn(JP_BANNER_SERVANT_SOURCE, {
    signal,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (
    !response.ok ||
    response.redirected ||
    !response.body ||
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Unsupported JP servant catalogue response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    body = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES)
        throw new Error("JP servant catalogue body limit exceeded.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    sourceUrl: JP_BANNER_SERVANT_SOURCE,
    contentHash: createHash("sha256").update(body).digest("hex"),
    servants: parseJpBannerServantCatalogue(JSON.parse(body) as unknown),
  };
}

export function resolveJpBannerServantMentions(
  mentions: readonly Mention[],
  catalogue: readonly Servant[],
) {
  if (mentions.length > 2_000 || catalogue.length > MAX_RECORDS)
    throw new Error("JP servant matching limit exceeded.");
  const names = new Map<string, Servant[]>();
  for (const servant of catalogue) {
    for (const name of new Set([
      normalize(servant.name),
      normalize(servant.originalName),
    ])) {
      const group = names.get(name) ?? [];
      if (
        !group.some(
          (candidate) => candidate.collectionNo === servant.collectionNo,
        )
      )
        group.push(servant);
      names.set(name, group);
    }
  }
  return mentions.map((mention) => {
    const normalized = normalize(mention.name);
    let named = names.get(normalized) ?? [];
    let classHint: { label: string; className: string } | null = null;
    // An exact full name wins. Never turn an unknown costume/variant into a base name.
    if (!named.length) {
      const suffix = /^(.*)\(([^()]+)\)$/u.exec(normalized);
      const className = suffix ? CLASS_SUFFIXES.get(suffix[2]!) : undefined;
      if (suffix && className) {
        classHint = { label: suffix[2]!, className };
        named = (names.get(suffix[1]!) ?? []).filter(
          (servant) => servant.className === className,
        );
      }
    }
    const candidates = named.filter(
      (servant) => servant.rarity === mention.rarity,
    );
    const status = !named.length
      ? ("NOT_FOUND" as const)
      : !candidates.length
        ? ("RARITY_MISMATCH" as const)
        : candidates.length > 1
          ? ("AMBIGUOUS" as const)
          : ("MATCHED" as const);
    return {
      ...mention,
      status,
      classHint,
      // Project IDs are collection numbers, not Atlas's internal servant IDs.
      servantId: status === "MATCHED" ? candidates[0]!.collectionNo : null,
      candidates: (candidates.length ? candidates : named).map(
        ({ collectionNo, name, rarity, className }) => ({
          servantId: collectionNo,
          name,
          rarity,
          className,
        }),
      ),
      matchingRule: classHint
        ? ("EXACT_NORMALIZED_JP_NAME_RARITY_AND_CLASS" as const)
        : ("EXACT_NORMALIZED_JP_NAME_AND_RARITY" as const),
      pickupMembershipConfirmed: false as const,
    };
  });
}

/** Partial source associations only: neither a complete roster nor a publishable banner. */
export function associateJpBannerPickupEvidence(
  schedule: ReturnType<typeof extractJpBannerSchedule>,
  identities: ReturnType<typeof resolveJpBannerServantMentions>,
  kind:
    | "SUMMON_CONTENT"
    | "RESTRICTED_SUMMON_CONTENT"
    | "NOT_RELEVANT"
    | "UNRESOLVED",
) {
  const linkedMentions = new Set<string>();
  const summonPeriods = schedule.periods.filter(
    (period) =>
      period.scope === "LABELLED_SUMMON" || period.scope === "ARTICLE_ENVELOPE",
  );
  const canShareNoticeEvidence =
    summonPeriods.length === 1 &&
    !schedule.pendingEvidence.includes(
      "INDIVIDUAL_PICKUP_WINDOWS_UNRESOLVED",
    ) &&
    !schedule.pendingEvidence.includes("IMAGE_SCHEDULE_UNINTERPRETED");
  const windows = summonPeriods.map((period) => {
    // Accept an exact named pickup, optionally prefixed by one quoted campaign label.
    // Do not strip arbitrary text or split names on punctuation used by real variants.
    const label = period.subject?.normalize("NFKC").trim() ?? "";
    const match = /^(?:「[^「」]+」\s*)?([^「」『』]+)ピックアップ召喚$/u.exec(
      label,
    );
    const quotedName =
      /^[◆◇\s]*[「『]([^「」『』]+)[」』]\s*ピックアップ召喚(?:の)?(?:開催)?期間[◆◇\s]*$/u.exec(
        period.label.normalize("NFKC"),
      );
    const names = new Set(
      [match?.[1], quotedName?.[1]].flatMap((name) =>
        name ? [normalize(name)] : [],
      ),
    );
    // A campaign-qualified title may end in an exact evidenced name after whitespace.
    // Keep every interpretation so overlapping full names remain ambiguous.
    const qualified = label
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .toLowerCase();
    for (const identity of identities) {
      const evidencedNames = [
        identity.name,
        ...(identity.status === "MATCHED"
          ? identity.candidates.map((candidate) => candidate.name)
          : []),
      ];
      for (const name of evidencedNames) {
        const suffix = name
          .normalize("NFKC")
          .trim()
          .replace(/\s+/gu, " ")
          .toLowerCase();
        if (suffix && qualified.endsWith(` ${suffix}ピックアップ召喚`))
          names.add(normalize(name));
      }
    }
    const mentioned = names.size
      ? identities.filter(
          (identity) =>
            names.has(normalize(identity.name)) ||
            (identity.status === "MATCHED" &&
              identity.candidates.some((candidate) =>
                names.has(normalize(candidate.name)),
              )),
        )
      : [];
    const ids = [
      ...new Set(
        mentioned.flatMap((identity) =>
          identity.servantId === null ? [] : [identity.servantId],
        ),
      ),
    ];
    const issues = [...period.issues];
    if (!names.size) issues.push("INDIVIDUAL_PICKUP_LABEL_UNRESOLVED");
    else if (!mentioned.length)
      issues.push("PICKUP_SUBJECT_WITHOUT_NAME_EVIDENCE");
    else if (
      ids.length !== 1 ||
      mentioned.some((identity) => identity.status !== "MATCHED")
    )
      issues.push("PICKUP_SUBJECT_IDENTITY_UNRESOLVED");
    if (!period.startsAt || !period.endsAt)
      issues.push("PICKUP_TIME_UNRESOLVED");
    if (kind === "RESTRICTED_SUMMON_CONTENT")
      issues.push("RESTRICTED_SUMMON_NOTICE");
    else if (kind !== "SUMMON_CONTENT")
      issues.push("NOTICE_EVIDENCE_UNRESOLVED");
    if (schedule.pendingEvidence.includes("INCOMPLETE_ARTICLE_EVIDENCE"))
      issues.push("INCOMPLETE_ARTICLE_EVIDENCE");
    const associations: {
      servantId: number;
      mentionEvidenceHashes: string[];
      rosterListEvidenceHashes: string[];
      basis:
        | "EXACT_NAMED_PICKUP_PERIOD_AND_CATALOGUE_IDENTITY"
        | "EXPLICIT_SHARED_PICKUP_STATEMENT"
        | "EXPLICIT_PICKUP_SERVANT_LIST";
    }[] = issues.length
      ? []
      : [
          {
            servantId: ids[0]!,
            mentionEvidenceHashes: [
              ...new Set(mentioned.map((identity) => identity.evidenceHash)),
            ],
            rosterListEvidenceHashes: [],
            basis: "EXACT_NAMED_PICKUP_PERIOD_AND_CATALOGUE_IDENTITY" as const,
          },
        ];
    if (associations.length && canShareNoticeEvidence) {
      const contexts = new Set(
        mentioned
          .map((identity) => identity.context)
          .filter((context) => {
            const statement = context.normalize("NFKC").replace(/\s+/gu, "");
            // Names and quoted campaign titles are data, not role/negation wording.
            const prose = statement.replace(/[「『][^「」『』]*[」』]/gu, "");
            const roleCount = [...prose.matchAll(/サーヴァント/gu)].length;
            const joinedRoles = prose.slice(prose.indexOf("サーヴァント"));
            return (
              /をピックアップ[!。]?$/u.test(prose) &&
              (roleCount === 1 ||
                (roleCount > 1 &&
                  /^サーヴァント(?:と、?(?:期間限定|ストーリー召喚|恒常)?サーヴァント)+をピックアップ[!。]?$/u.test(
                    joinedRoles,
                  ))) &&
              [...prose.matchAll(/ピックアップ/gu)].length === 1 &&
              !/場合|一例|例として|たとえば|など|含む|ほか|別の|対象外|除く|以外|ません|ボーナス|特攻|強化|クエスト|確定|より|ではなく|のみ|だけ|代わり/u.test(
                prose,
              )
            );
          }),
      );
      for (const identity of identities) {
        if (
          identity.status !== "MATCHED" ||
          identity.servantId === null ||
          !contexts.has(identity.context)
        )
          continue;
        const existing = associations.find(
          (association) => association.servantId === identity.servantId,
        );
        if (existing) {
          if (!existing.mentionEvidenceHashes.includes(identity.evidenceHash))
            existing.mentionEvidenceHashes.push(identity.evidenceHash);
        } else
          associations.push({
            servantId: identity.servantId,
            mentionEvidenceHashes: [identity.evidenceHash],
            rosterListEvidenceHashes: [],
            basis: "EXPLICIT_SHARED_PICKUP_STATEMENT",
          });
      }
    }
    if (
      associations.length &&
      canShareNoticeEvidence &&
      schedule.pickupRosterLists.length === 1
    ) {
      const roster = schedule.pickupRosterLists[0]!;
      const members = roster.members.flatMap((member) => {
        const identity = identities.find(
          (identity) => identity.evidenceHash === member.evidenceHash,
        );
        return identity?.status === "MATCHED" && identity.servantId !== null
          ? [{ ...identity, servantId: identity.servantId }]
          : [];
      });
      if (
        !roster.issues.length &&
        members.length &&
        members.length === roster.members.length &&
        members.some((member) =>
          mentioned.some(
            (identity) => identity.evidenceHash === member.evidenceHash,
          ),
        )
      ) {
        for (const member of members) {
          const existing = associations.find(
            (association) => association.servantId === member.servantId,
          );
          if (existing) {
            if (!existing.mentionEvidenceHashes.includes(member.evidenceHash))
              existing.mentionEvidenceHashes.push(member.evidenceHash);
            if (
              !existing.rosterListEvidenceHashes.includes(roster.evidenceHash)
            )
              existing.rosterListEvidenceHashes.push(roster.evidenceHash);
          } else
            associations.push({
              servantId: member.servantId,
              mentionEvidenceHashes: [member.evidenceHash],
              rosterListEvidenceHashes: [roster.evidenceHash],
              basis: "EXPLICIT_PICKUP_SERVANT_LIST",
            });
        }
      }
    }
    for (const association of associations)
      for (const evidenceHash of association.mentionEvidenceHashes)
        linkedMentions.add(evidenceHash);
    return {
      periodEvidenceHash: period.evidenceHash,
      subject: period.subject,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      associations,
      issues: [...new Set(issues)],
      rosterComplete: false as const,
      publicationAllowed: false as const,
    };
  });
  return {
    windows,
    unassociatedMentionHashes: identities
      .filter((identity) => !linkedMentions.has(identity.evidenceHash))
      .map((identity) => identity.evidenceHash),
    publicationAllowed: false as const,
  };
}
