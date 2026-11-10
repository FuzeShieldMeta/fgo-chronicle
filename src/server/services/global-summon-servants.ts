import { createHash } from "node:crypto";
import {
  GLOBAL_SUMMON_SECTION_LIMITS,
  SERVANT_CATALOGUE_LIMITS,
} from "../../shared/global-reconciliation-config";
import { servantClassKey } from "../../shared/servant-class.mjs";
import {
  lookupServantName,
  servantNameIndex,
  type ServantCatalogueEntry,
} from "./servant-name-lookup";
import type { parsePublisherAnnouncement } from "./global-announcement-parser";
import { previewStandardBannerRoster } from "./banner-roster";

type Article = ReturnType<typeof parsePublisherAnnouncement>;
type Section = NonNullable<Article["summonSections"]>[number];
export type GlobalSummonCatalogueEntry = {
  id: number;
  name: string;
  className: string;
  rarity: number | null;
  atlasNaAvailable: boolean | null;
  aliases?: readonly string[];
};
export type GlobalSummonCatalogue = ReadonlyMap<
  number,
  Omit<GlobalSummonCatalogueEntry, "id">
>;

export function bindGlobalSummonCatalogue(
  stored: readonly GlobalSummonCatalogueEntry[],
  source: GlobalSummonCatalogue | undefined,
) {
  return stored.map((servant) => {
    const canonical = source?.get(servant.id);
    return canonical?.aliases?.length &&
      canonical.name === servant.name &&
      servantClassKey(canonical.className) ===
        servantClassKey(servant.className) &&
      canonical.rarity === servant.rarity &&
      canonical.atlasNaAvailable === servant.atlasNaAvailable
      ? { ...servant, aliases: canonical.aliases }
      : servant;
  });
}

export function resolveGlobalSummonServants(
  sections: readonly Section[],
  catalogue: readonly GlobalSummonCatalogueEntry[],
) {
  if (
    catalogue.length > SERVANT_CATALOGUE_LIMITS.maxRecords ||
    sections.some(
      (section) =>
        section.rawServants.length > GLOBAL_SUMMON_SECTION_LIMITS.maxMembers,
    )
  )
    throw new Error("Global servant matching limit exceeded.");
  const rows = catalogue
    .map(({ id, name, className, rarity, atlasNaAvailable, aliases }) => ({
      id,
      name,
      className,
      rarity,
      atlasNaAvailable,
      ...(aliases?.length ? { aliases: [...new Set(aliases)].sort() } : {}),
    }))
    .sort((a, b) => a.id - b.id);
  const contentHash = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  const names = servantNameIndex(
    rows.flatMap((servant) =>
      servant.rarity === null
        ? []
        : [
            {
              collectionNo: servant.id,
              name: servant.name,
              originalName: servant.name,
              className: servant.className,
              rarity: servant.rarity,
              aliases: [
                ...(servant.aliases ?? []),
                ...classQualifiedAliases(servant),
              ],
            },
          ],
    ),
  );
  const available = new Set(
    rows.filter((row) => row.atlasNaAvailable === true).map((row) => row.id),
  );
  return sections.map((section) => {
    const members = section.rawServants.map((member) => {
      const { named } = lookupServantName(member.name, names);
      const matchingClass = named.filter(
        (candidate) =>
          servantClassKey(candidate.className) ===
          servantClassKey(member.className),
      );
      const matchingRarity = matchingClass.filter(
        (candidate) => candidate.rarity === member.rarity,
      );
      const status = servantMatchStatus(
        named.length,
        matchingClass.length,
        matchingRarity,
        available,
      );
      return {
        ...member,
        status,
        servantId:
          status === "MATCHED" ? matchingRarity[0]!.collectionNo : null,
        candidateIds: named
          .map((candidate) => candidate.collectionNo)
          .sort((a, b) => a - b),
      };
    });
    const ids = members.flatMap((member) =>
      member.servantId === null ? [] : [member.servantId],
    );
    const issues = [...section.issues];
    if (members.some((member) => member.status !== "MATCHED"))
      issues.push("PICKUP_CATALOGUE_UNRESOLVED");
    if (new Set(ids).size !== ids.length)
      issues.push("DUPLICATE_PICKUP_IDENTITY");
    const evidence = {
      sectionEvidenceHash: section.evidenceHash,
      catalogueContentHash: contentHash,
      members,
    };
    const roster = previewStandardBannerRoster(
      members
        .flatMap((member) =>
          member.servantId === null
            ? []
            : [
                {
                  servantId: member.servantId,
                  rarity: member.rarity,
                  className: member.className,
                },
              ],
        )
        .sort((a, b) => a.servantId - b.servantId),
    );
    const rosterIssues = [...new Set([...issues, ...roster.issues])];
    return {
      ...section,
      catalogueResolution: {
        ...evidence,
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(evidence))
          .digest("hex"),
        status: issues.length ? ("HELD" as const) : ("MATCHED" as const),
        issues: [...new Set(issues)],
        publicationAllowed: false as const,
      },
      rosterProposal: {
        ...roster,
        issues: rosterIssues,
        evidenceHash: createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              sectionEvidenceHash: section.evidenceHash,
              catalogueContentHash: contentHash,
              rateRule: roster.rateRule,
              featured: roster.featured,
            }),
          )
          .digest("hex"),
        status: rosterIssues.length
          ? ("HELD" as const)
          : ("REQUIRES_ROSTER_REVIEW" as const),
        publicationAllowed: false as const,
      },
    };
  });
}

function servantMatchStatus(
  nameMatches: number,
  classMatches: number,
  rarityMatches: readonly ServantCatalogueEntry[],
  available: ReadonlySet<number>,
) {
  if (nameMatches === 0) return "NOT_FOUND";
  if (classMatches === 0) return "CLASS_MISMATCH";
  const [candidate] = rarityMatches;
  if (!candidate) return "RARITY_MISMATCH";
  if (rarityMatches.length > 1) return "AMBIGUOUS";
  if (!available.has(candidate.collectionNo)) return "NA_CATALOGUE_UNVERIFIED";
  return "MATCHED";
}

function classQualifiedAliases(servant: GlobalSummonCatalogueEntry) {
  return [servant.name, ...(servant.aliases ?? [])].flatMap((name) => {
    const qualified = /^(.+)\(([^()]+)\)$/u.exec(name.normalize("NFKC").trim());
    return qualified &&
      servantClassKey(qualified[2]!) === servantClassKey(servant.className)
      ? [qualified[1]!.trim()]
      : [];
  });
}
