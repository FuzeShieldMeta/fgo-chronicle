import { createHash } from "node:crypto";

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
