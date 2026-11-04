import { createHash } from "node:crypto";
import {
  JP_BANNER_HTML_SECTION_LIMITS,
  type extractJpBannerSchedule,
  type JpBannerHtmlPickupSection,
} from "./jp-banner-schedule";

export const JP_BANNER_SERVANT_SOURCE =
  "https://api.atlasacademy.io/export/JP/basic_servant.json";
const MAX_BYTES = 8 * 1_024 * 1_024;
const MAX_RECORDS = 2_000;
const MAX_NAME = 200;
const RARITY_LABELS: Readonly<Record<string, number>> = {
  ssr: 5,
  sr: 4,
  r: 3,
  uc: 2,
  c: 1,
};
// Only recognized class labels may qualify a name; other variant suffixes stay intact.
const CLASS_SUFFIXES = new Map([
  ["セイバー", "saber"],
  ["アーチャー", "archer"],
  ["ランサー", "lancer"],
  ["ライダー", "rider"],
  ["キャスター", "caster"],
  ["アサシン", "assassin"],
  ["バーサーカー", "berserker"],
  ["ルーラー", "ruler"],
  ["アヴェンジャー", "avenger"],
  ["ムーンキャンサー", "moonCancer"],
  ["アルターエゴ", "alterEgo"],
  ["フォーリナー", "foreigner"],
  ["プリテンダー", "pretender"],
  ["シールダー", "shielder"],
  ["ビースト", "beast"],
]);

type Servant = {
  collectionNo: number;
  name: string;
  originalName: string;
  aliases?: readonly string[];
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
    const aliases: string[] = [];
    for (const field of ["overwriteName", "originalOverwriteName"] as const) {
      const alias = row[field];
      if (alias === undefined) continue;
      if (typeof alias !== "string" || !alias.trim() || alias.length > MAX_NAME)
        throw new Error("Unsupported JP servant catalogue alternate name.");
      if (!aliases.includes(alias.trim())) aliases.push(alias.trim());
    }
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
      ...(aliases.length ? { aliases } : {}),
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

function servantNameIndex(catalogue: readonly Servant[]) {
  const names = new Map<string, Servant[]>();
  for (const servant of catalogue) {
    for (const name of new Set([
      normalize(servant.name),
      normalize(servant.originalName),
      ...(servant.aliases ?? []).map(normalize),
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
  return names;
}

function lookupServantName(
  name: string,
  names: ReturnType<typeof servantNameIndex>,
) {
  const normalized = normalize(name);
  const exact = names.get(normalized);
  if (exact?.length)
    return { named: exact, classHint: null, nameParts: [normalized] };
  // Keep the longest exact catalogue prefix, including literal variant suffixes.
  // Each remaining parenthesis must name the same identity or constrain its class.
  const openings = [...normalized.matchAll(/\(/gu)].map((match) => match.index);
  for (const index of openings.reverse()) {
    const base = normalized.slice(0, index);
    const suffix = normalized.slice(index);
    const prefix = names.get(base);
    if (!prefix?.length || !/^(?:\([^()]+\))+$/u.test(suffix)) continue;
    let named = prefix;
    let classHint: { label: string; className: string } | null = null;
    const nameParts = [base];
    for (const match of suffix.matchAll(/\(([^()]+)\)/gu)) {
      const part = match[1]!;
      const className = CLASS_SUFFIXES.get(part);
      if (className) {
        classHint ??= { label: part, className };
        named = named.filter((servant) => servant.className === className);
      } else {
        const aliases = names.get(part);
        if (!aliases?.length) return { named: [], classHint, nameParts };
        const ids = new Set(aliases.map((servant) => servant.collectionNo));
        named = named.filter((servant) => ids.has(servant.collectionNo));
        nameParts.push(part);
      }
    }
    return { named, classHint, nameParts };
  }
  return { named: [], classHint: null, nameParts: [normalized] };
}

function catalogueCandidates(servants: readonly Servant[]) {
  return servants.map(({ collectionNo, name, rarity, className, aliases }) => ({
    servantId: collectionNo,
    name,
    ...(aliases?.length ? { aliases } : {}),
    rarity,
    className,
  }));
}

export function resolveJpBannerServantMentions(
  mentions: readonly Mention[],
  catalogue: readonly Servant[],
) {
  if (mentions.length > 2_000 || catalogue.length > MAX_RECORDS)
    throw new Error("JP servant matching limit exceeded.");
  const names = servantNameIndex(catalogue);
  return mentions.map((mention) => {
    const { named, classHint, nameParts } = lookupServantName(
      mention.name,
      names,
    );
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
      candidates: catalogueCandidates(candidates.length ? candidates : named),
      ...(nameParts.length > 1 ? { catalogueNameParts: nameParts } : {}),
      matchingRule:
        nameParts.length > 1
          ? ("EXACT_CATALOGUE_NAME_COMPONENTS_AND_RARITY" as const)
          : classHint
            ? ("EXACT_NORMALIZED_JP_NAME_RARITY_AND_CLASS" as const)
            : ("EXACT_NORMALIZED_JP_NAME_AND_RARITY" as const),
      pickupMembershipConfirmed: false as const,
    };
  });
}

/** Catalogue identity evidence only: source rarity/class and banner authority stay unchanged. */
export function resolveJpBannerHtmlSectionNames(
  sections: readonly JpBannerHtmlPickupSection[],
  catalogue: readonly Servant[],
  provenance: Pick<
    Awaited<ReturnType<typeof fetchJpBannerServantCatalogue>>,
    "sourceUrl" | "contentHash"
  >,
): JpBannerHtmlPickupSection[] {
  if (
    catalogue.length > MAX_RECORDS ||
    sections.length > JP_BANNER_HTML_SECTION_LIMITS.maxSections ||
    sections.some(
      (section) =>
        section.names.length > JP_BANNER_HTML_SECTION_LIMITS.maxNamesPerSection,
    )
  )
    throw new Error("JP section identity matching limit exceeded.");
  if (!sections.length) return [];
  const names = servantNameIndex(catalogue);
  return sections.map((section) => ({
    ...section,
    names: section.names.map((member) => {
      const { named, classHint, nameParts } = lookupServantName(
        member.name,
        names,
      );
      const identityStatus = !named.length
        ? ("NOT_FOUND" as const)
        : named.length > 1
          ? ("AMBIGUOUS" as const)
          : ("MATCHED" as const);
      return {
        ...member,
        identityStatus,
        catalogueIdentity: {
          servantId:
            identityStatus === "MATCHED" ? named[0]!.collectionNo : null,
          candidates: catalogueCandidates(named),
          classHint,
          ...(nameParts.length > 1 ? { catalogueNameParts: nameParts } : {}),
          matchingRule:
            nameParts.length > 1
              ? ("EXACT_CATALOGUE_NAME_COMPONENTS_UNIQUE_CATALOGUE" as const)
              : classHint
                ? ("EXACT_NORMALIZED_JP_NAME_AND_CLASS_UNIQUE_CATALOGUE" as const)
                : ("EXACT_NORMALIZED_JP_NAME_UNIQUE_CATALOGUE" as const),
          sourceUrl: provenance.sourceUrl,
          contentHash: provenance.contentHash,
          pickupMembershipConfirmed: false as const,
        },
      };
    }),
  }));
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
    const qualified = (quotedName ? `${quotedName[1]}ピックアップ召喚` : label)
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .toLowerCase();
    for (const identity of identities) {
      const evidencedNames = [
        identity.name,
        ...(identity.status === "MATCHED"
          ? identity.candidates.flatMap((candidate) => [
              candidate.name,
              ...(candidate.aliases ?? []),
            ])
          : []),
      ];
      for (const name of evidencedNames) {
        const suffix = name
          .normalize("NFKC")
          .trim()
          .replace(/\s+/gu, " ")
          .toLowerCase();
        const ending = `${suffix}ピックアップ召喚`;
        if (!suffix || !qualified.endsWith(ending)) continue;
        const prefix = qualified.slice(0, -ending.length);
        const rarity = /(?:^|\s)[★☆]\s*(\d+)(?:\s*\(([^()]*)\))?\s*$/u.exec(
          prefix,
        );
        if (rarity) {
          const value = Number(rarity[1]);
          if (
            value === identity.rarity &&
            (rarity[2] === undefined || RARITY_LABELS[rarity[2]] === value)
          )
            names.add(normalize(name));
        } else if (
          prefix.endsWith(" ") &&
          !/(?:^|\s)[★☆]/u.test(prefix)
        ) {
          names.add(normalize(name));
        }
      }
    }
    const mentioned = names.size
      ? identities.filter(
          (identity) =>
            names.has(normalize(identity.name)) ||
            (identity.status === "MATCHED" &&
              identity.candidates.some((candidate) =>
                [candidate.name, ...(candidate.aliases ?? [])].some((name) =>
                  names.has(normalize(name)),
                ),
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
      countedRosterReview: reviewCountedRoster(
        schedule,
        identities,
        issues,
        canShareNoticeEvidence,
        associations,
      ),
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

function reviewCountedRoster(
  schedule: ReturnType<typeof extractJpBannerSchedule>,
  identities: ReturnType<typeof resolveJpBannerServantMentions>,
  windowIssues: readonly string[],
  singleWindow: boolean,
  associations: readonly { servantId: number }[],
) {
  const declarations = schedule.pickupRosterDeclarations;
  const lists = schedule.pickupRosterLists;
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  const list = lists.length === 1 ? lists[0] : undefined;
  const issues = [...windowIssues];
  if (!declarations.length)
    issues.push("COUNTED_ROSTER_DECLARATION_UNAVAILABLE");
  else if (declarations.length !== 1)
    issues.push("MULTIPLE_COUNTED_ROSTER_DECLARATIONS");
  if (lists.length !== 1) issues.push("PICKUP_ROSTER_LIST_NOT_UNIQUE");
  if (!singleWindow) issues.push("SINGLE_PICKUP_WINDOW_REQUIRED");
  if (schedule.unparsedPeriods.length) issues.push("UNPARSED_PERIOD_EVIDENCE");
  issues.push(...(declaration?.issues ?? []), ...(list?.issues ?? []));
  const resolveMembers = (members: readonly { evidenceHash: string }[]) =>
    members.map((member) =>
      identities.find(
        (identity) => identity.evidenceHash === member.evidenceHash,
      ),
    );
  const declared = resolveMembers(declaration?.members ?? []);
  const listed = resolveMembers(list?.members ?? []);
  const ids = (members: typeof declared) =>
    [
      ...new Set(
        members.flatMap((member) =>
          member?.status === "MATCHED" && member.servantId !== null
            ? [member.servantId]
            : [],
        ),
      ),
    ].sort((a, b) => a - b);
  const declaredIds = ids(declared),
    listedIds = ids(listed);
  if (
    declaration &&
    (declared.length !== declaredIds.length ||
      declared.some((member) => member?.status !== "MATCHED"))
  )
    issues.push("COUNTED_ROSTER_IDENTITIES_UNRESOLVED");
  if (
    list &&
    (listed.length !== listedIds.length ||
      listed.some((member) => member?.status !== "MATCHED"))
  )
    issues.push("LIST_ROSTER_IDENTITIES_UNRESOLVED");
  if (
    declaration &&
    list &&
    (declaredIds.length !== declaration.declaredCount ||
      listedIds.length !== declaration.declaredCount ||
      JSON.stringify(declaredIds) !== JSON.stringify(listedIds))
  )
    issues.push("COUNTED_ROSTER_LIST_MISMATCH");
  if (
    declaration &&
    JSON.stringify(
      [...new Set(associations.map((member) => member.servantId))].sort(
        (a, b) => a - b,
      ),
    ) !== JSON.stringify(declaredIds)
  )
    issues.push("COUNTED_ROSTER_WINDOW_BINDING_UNRESOLVED");
  return {
    status: !declarations.length
      ? ("UNAVAILABLE" as const)
      : issues.length
        ? ("HELD" as const)
        : ("CONSISTENT_REVIEW_REQUIRED" as const),
    declaredServantCount: declaration?.declaredCount ?? null,
    declaredServantIds: declaredIds,
    listedServantIds: listedIds,
    members: declaredIds.map((servantId) => ({
      servantId,
      rarity: declared.find((member) => member?.servantId === servantId)!
        .rarity,
    })),
    declarationEvidenceHashes: declarations.map((item) => item.evidenceHash),
    listEvidenceHashes: lists.map((item) => item.evidenceHash),
    issues: [...new Set(issues)],
    rosterComplete: false as const,
    publicationAllowed: false as const,
  };
}
