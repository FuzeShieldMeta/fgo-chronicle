import {
  inventoryJpBannerAnnouncements,
  type JpBannerInventoryOptions,
} from "../src/server/services/jp-banner-inventory";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { bannerDatasetSchema } from "../src/server/services/banner-dataset";
import {
  compareJpBannerEvidence,
  JP_BANNER_COMPARISON_LIMITS,
} from "../src/server/services/jp-banner-comparison";
import {
  jpBannerImageDraftSchema,
  validateJpBannerImageDrafts,
  JP_BANNER_IMAGE_DRAFT_LIMITS,
} from "../src/server/services/jp-banner-image-drafts";
import {
  JP_BANNER_IDENTITY_LIMITS,
  jpBannerIdentityMapSchema,
  previewJpBannerIdentityMap,
} from "../src/server/services/jp-banner-identity";
import {
  bannerIdentityAcceptanceSchema,
  previewBannerSourceIdentities,
  registerBannerSourceIdentities,
} from "../src/server/services/banner-source-identity";
import {
  bannerPublicationFieldsSchema,
  bannerPublicationAcceptanceSchema,
  previewBannerSourcePublication,
  publishBannerSourceValues,
} from "../src/server/services/banner-source-publication";
import {
  jpBannerFamilyTimingSchema,
  previewJpBannerFamilyTiming,
} from "../src/server/services/jp-banner-family-timing";

async function localJson(file: string, maxBytes: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Input must be a regular file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Input file size limit exceeded.");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    ) as unknown;
  } finally {
    await handle.close();
  }
}

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(
      "Usage: npm run data:review-jp-banners -- [--pages=1..50 --start-page=1..5000 | --article=OFFICIAL_URL ...] [--inspect=0..20] [--follow-links=0..20] [--resolve-servants] [--project-na] [--inspect-images=0..10] [--image-drafts=LOCAL_DRAFT.json] [--compare=LOCAL_DATASET.json]\nRead-only JP announcement inspection. Defaults to two archive pages and no article requests. --article selects official JP articles directly (up to 20, inspected by default) instead of reading an index. --follow-links adds bounded official linked-notice requests; inspect plus follow-links must not exceed 20. Links do not establish family identity. --resolve-servants matches catalogue identities and explicit pickup statements. --project-na previews reset-relative NA times using one estimated notice anchor and a two-calendar-year shift, not confirmed NA availability. --inspect-images downloads bounded labelled schedule-image candidates for original-content hashes and dimensions; it does not interpret them or call a model. --image-drafts requires image inspection and projection; it checks a bounded manual draft against current hashes, coordinates and source bounds. Consistency is not approval or verified portrait identity. --compare requires servant resolution and projection and compares partial evidence with a bounded local banner dataset; servant overlap suggests possible matches, never confirmed identity. Comparison includes paragraph pickup evidence and HTML pickup sections; catalogue name overlap in a section does not confirm pickup membership. Unresolved section names or timing hold that section. Date-only baselines have no inferred clock or instant difference. No publication or model uploads.",
    );
    console.log(
      "Archive range: --listed-from=YYYY-MM-DD --listed-through=YYYY-MM-DD selects inclusive JP listing dates, not banner dates or projected NA dates. Both flags are required together and cannot be used with --article. Undated/conflicting sources and linked notices remain eligible. Archive scanning still uses the page/deadline budgets; an old listing does not prove traversal is complete.",
    );
    console.log(
      "HTML pickup sections: htmlPickupSections retains supported section IDs, local date text, servant-role name text and source hashes. --resolve-servants reuses the catalogue lookup for unique exact-name matches; ambiguous variants remain unresolved. Catalogue IDs/rarities/classes are separate from unknown raw HTML rarity/class, with catalogue URL/hash retained. --project-na reports htmlSectionWindows after optional resolution using the common notice reset estimate. Missing dates are never inherited from an envelope or sibling. Existing article/image holds remain. Catalogue matches do not register banner identities or grant publication ownership; no image recognition or live fallback is added.",
    );
    console.log(
      "Coverage: discoveryCoverage reports observed page dates/hashes, archive traversal and article inspection separately. Date bounds do not prove coverage; even OBSERVED_ARCHIVE_TRAVERSED does not mean complete banner extraction. archiveContinuation continues discovery only: it is not an article retry, a stable snapshot or proof of combined coverage across runs. Rerun an older start page if archive pagination shifts; retain earlier reports when reviewing chunks.",
    );
    console.log(
      "Identity preview: --identity-map=LOCAL_MAP.json requires --compare, --resolve-servants and --project-na. Explicit reviewer-assigned pickup identities are checked against current article/period evidence and baseline target fingerprints. An optional htmlSection selector pins sectionId, sectionEvidenceHash and catalogueContentHash for read-only section identity/family-timing review. It cannot register or publish section-backed evidence; catalogue name identity does not confirm pickup membership. With servant resolution, countedRosterReview compares explicit named totals with pickup lists and retains catalogue/list/declaration hashes. Agreement remains a review candidate, not complete-roster approval or probability evidence. rosterProposal derives members from one explicit pickup list; rosterReview pins its evidenceHash and requires confirmCompleteRoster:true, rateRule:STANDARD_RATE_UP and acknowledgeRemovedTargets. Explicit roster review permits adopting a differing legacy roster; ordinary automatic matching remains unchanged. Draft URLs never select sources. Conflicts or stale evidence hold the proposal; consistency is not identity confirmation, full roster evidence, database-ID verification or publication approval. No rekeying or writes.",
    );
    console.log(
      "Database identity review: --database-preview requires --identity-map and an explicitly configured DATABASE_URL. It reads current target IDs and database fingerprints without writes. --accept-identities=LOCAL_ACCEPTANCE.json --actor-id=CURATOR_ID additionally registers only reviewed bindings in one audited transaction. Acceptance requires --database-preview and an exact matching identity map, including current source/baseline evidence. No banner fields, lineups or publication ownership are changed. Never run acceptance from cron.",
    );
    console.log(
      "Publication review: add --publication-fields=NAME,SOURCE to --database-preview for a read-only field diff and ownership revision. SOURCE,TIMING can additionally publish exact pickup clocks using an explicitly reviewed --family-anchors file, or reuse a stored family anchor. Copy each timing review snapshot into its accepted binding and include the selected familyAnchors input at the root. Exact original JP clocks are required; lineups and existing date overlays remain held. SOURCE,ROSTER can publish a reviewed complete pickup list using rosterReview in both the identity map and acceptance. Unsupported rates, incomplete evidence, protected targets and lineups remain held. The preview lists removed servant targets; no saved plan is retargeted. Spreadsheet sync preserves announcement-owned rosters. --publish-reviewed=LOCAL_PUBLICATION.json --actor-id=CURATOR_ID explicitly accepts the reviewed values and revisions. It cannot register identities or insert banners. Never run acceptance or reviewed publication from cron.",
    );
    console.log(
      "Family timing review: --family-anchors=LOCAL_ANCHORS.json requires --database-preview and its identity-map/comparison inputs. Without publication fields it remains a read-only comparison. Combine only with publication fields including TIMING for reviewed timing publication. Identity registration remains separate. Stored anchor facts are rechecked on reuse; no source URL in a review file selects a network request.",
    );
  } else {
    const options: JpBannerInventoryOptions = {};
    let baselineFile: string | null = null;
    let imageDraftFile: string | null = null;
    let identityMapFile: string | null = null;
    let databasePreview = false;
    let acceptanceFile: string | null = null;
    let actorId: string | null = null;
    let publicationFields: ReturnType<
      typeof bannerPublicationFieldsSchema.parse
    > | null = null;
    let publicationFile: string | null = null;
    let familyTimingFile: string | null = null;
    const seen = new Set<string>();
    for (const argument of process.argv.slice(2)) {
      if (argument === "--database-preview") {
        if (databasePreview)
          throw new Error("Duplicate database preview flag.");
        databasePreview = true;
        continue;
      }
      if (
        argument.startsWith("--accept-identities=") ||
        argument.startsWith("--actor-id=") ||
        argument.startsWith("--publish-reviewed=") ||
        argument.startsWith("--publication-fields=") ||
        argument.startsWith("--family-anchors=")
      ) {
        const [flag, ...parts] = argument.split("=");
        const value = parts.join("=");
        if (!value || seen.has(flag!))
          throw new Error("Invalid acceptance arguments.");
        seen.add(flag!);
        if (flag === "--actor-id") actorId = value;
        else if (flag === "--publication-fields")
          publicationFields = bannerPublicationFieldsSchema.parse(
            value.split(","),
          );
        else if (flag === "--publish-reviewed") publicationFile = value;
        else if (flag === "--family-anchors") familyTimingFile = value;
        else acceptanceFile = value;
        continue;
      }
      if (argument.startsWith("--identity-map=")) {
        if (
          identityMapFile !== null ||
          !argument.slice("--identity-map=".length)
        )
          throw new Error("Invalid identity map file.");
        identityMapFile = argument.slice("--identity-map=".length);
        continue;
      }
      const listingDate = /^--(listed-from|listed-through)=(.+)$/.exec(
        argument,
      );
      if (listingDate) {
        if (seen.has(listingDate[1]!))
          throw new Error("Duplicate listing date argument.");
        seen.add(listingDate[1]!);
        options[
          listingDate[1] === "listed-from" ? "listedFrom" : "listedThrough"
        ] = listingDate[2]!;
        continue;
      }
      if (argument.startsWith("--image-drafts=")) {
        if (
          imageDraftFile !== null ||
          !argument.slice("--image-drafts=".length)
        )
          throw new Error("Invalid image draft file.");
        imageDraftFile = argument.slice("--image-drafts=".length);
        continue;
      }
      if (argument.startsWith("--compare=")) {
        if (baselineFile !== null || !argument.slice("--compare=".length))
          throw new Error("Invalid comparison file.");
        baselineFile = argument.slice("--compare=".length);
        continue;
      }
      if (argument.startsWith("--article=")) {
        options.articleUrls ??= [];
        options.articleUrls.push(argument.slice("--article=".length));
        continue;
      }
      if (argument === "--resolve-servants" || argument === "--project-na") {
        if (seen.has(argument))
          throw new Error("Duplicate servant resolution argument.");
        seen.add(argument);
        if (argument === "--resolve-servants") options.resolveServants = true;
        else options.projectNa = true;
        continue;
      }
      const match =
        /^--(pages|start-page|inspect|follow-links|inspect-images)=(0|[1-9]\d*)$/.exec(
          argument,
        );
      if (!match || seen.has(match[1]!))
        throw new Error("Invalid JP inventory arguments.");
      seen.add(match[1]!);
      options[
        match[1] === "pages"
          ? "pages"
          : match[1] === "inspect"
            ? "inspect"
            : match[1] === "follow-links"
              ? "followLinks"
              : match[1] === "inspect-images"
                ? "inspectImages"
                : "startPage"
      ] = Number(match[2]);
    }
    if (baselineFile && (!options.resolveServants || !options.projectNa))
      throw new Error("Comparison requires identity and projection evidence.");
    if (identityMapFile && !baselineFile)
      throw new Error("Identity preview requires a comparison baseline.");
    if (
      (databasePreview && !identityMapFile) ||
      Boolean(acceptanceFile ?? publicationFile) !== Boolean(actorId) ||
      (acceptanceFile && !databasePreview) ||
      (acceptanceFile && (publicationFile || publicationFields)) ||
      (publicationFields && !databasePreview) ||
      (publicationFile && !publicationFields) ||
      (familyTimingFile &&
        (!databasePreview ||
          acceptanceFile ||
          (publicationFields && !publicationFields.includes("TIMING")))) ||
      (databasePreview && !process.env.DATABASE_URL)
    )
      throw new Error(
        "Database review requires explicit evidence, database configuration and paired acceptance arguments.",
      );
    if (
      imageDraftFile &&
      (!(options.inspectImages && options.inspectImages > 0) ||
        !options.projectNa)
    )
      throw new Error(
        "Image drafts require current image evidence and projection.",
      );
    const familyTimingInput = familyTimingFile
      ? jpBannerFamilyTimingSchema.parse(
          await localJson(
            familyTimingFile,
            JP_BANNER_IDENTITY_LIMITS.maxFileBytes,
          ),
        )
      : null;
    const baseline = baselineFile
      ? bannerDatasetSchema.parse(
          await localJson(
            baselineFile,
            JP_BANNER_COMPARISON_LIMITS.maxBaselineBytes,
          ),
        )
      : null;
    const imageDrafts = imageDraftFile
      ? jpBannerImageDraftSchema.parse(
          await localJson(
            imageDraftFile,
            JP_BANNER_IMAGE_DRAFT_LIMITS.maxFileBytes,
          ),
        )
      : null;
    const identityMap = identityMapFile
      ? jpBannerIdentityMapSchema.parse(
          await localJson(
            identityMapFile,
            JP_BANNER_IDENTITY_LIMITS.maxFileBytes,
          ),
        )
      : null;
    const acceptance = acceptanceFile
      ? bannerIdentityAcceptanceSchema.parse(
          await localJson(
            acceptanceFile,
            JP_BANNER_IDENTITY_LIMITS.maxFileBytes,
          ),
        )
      : null;
    const publicationAcceptance = publicationFile
      ? bannerPublicationAcceptanceSchema.parse(
          await localJson(
            publicationFile,
            JP_BANNER_IDENTITY_LIMITS.maxFileBytes,
          ),
        )
      : null;
    const accepted = acceptance ?? publicationAcceptance;
    if (accepted) {
      const acceptedMap = jpBannerIdentityMapSchema.parse({
        version: 1,
        mappings: accepted.bindings.map((binding) => ({
          sourceKey: binding.sourceKey,
          sourceUrl: binding.sourceUrl,
          articleContentHash: binding.articleContentHash,
          periodEvidenceHash: binding.periodEvidenceHash,
          ...(binding.rosterReview
            ? { rosterReview: binding.rosterReview }
            : {}),
          targetSourceKey: binding.targetSourceKey,
          targetContentHash: binding.targetContentHash,
        })),
      });
      if (JSON.stringify(acceptedMap) !== JSON.stringify(identityMap))
        throw new Error(
          "Acceptance must match the explicitly selected identity map.",
        );
    }
    if (
      publicationAcceptance?.bindings.some(
        (binding) =>
          JSON.stringify(binding.fields) !== JSON.stringify(publicationFields),
      )
    )
      throw new Error(
        "Publication acceptance must match the explicitly selected fields.",
      );
    if (
      publicationAcceptance &&
      JSON.stringify(publicationAcceptance.familyAnchors ?? null) !==
        JSON.stringify(familyTimingInput)
    )
      throw new Error(
        "Publication acceptance must match the selected family anchors.",
      );
    const report = await inventoryJpBannerAnnouncements(options);
    const draftValidation = imageDrafts
      ? validateJpBannerImageDrafts(report, imageDrafts)
      : null;
    const identityPreview =
      identityMap && baseline
        ? previewJpBannerIdentityMap(report, baseline, identityMap)
        : null;
    let databaseIdentityPreview: Awaited<
      ReturnType<typeof previewBannerSourceIdentities>
    > | null = null;
    let identityRegistration: Awaited<
      ReturnType<typeof registerBannerSourceIdentities>
    > | null = null;
    let publicationPreview: Awaited<
      ReturnType<typeof previewBannerSourcePublication>
    > | null = null;
    let publication: Awaited<
      ReturnType<typeof publishBannerSourceValues>
    > | null = null;
    let familyTimingPreview: Awaited<
      ReturnType<typeof previewJpBannerFamilyTiming>
    > | null = null;
    if (databasePreview && identityMap && baseline) {
      const { PrismaClient } = await import("../generated/prisma/index.js");
      const database = new PrismaClient({
        datasourceUrl: process.env.DATABASE_URL,
        log: [],
      });
      try {
        if (familyTimingInput && !publicationFields) {
          familyTimingPreview = await previewJpBannerFamilyTiming(
            database,
            report,
            baseline,
            identityMap,
            familyTimingInput,
          );
        } else if (publicationFields) {
          publicationPreview = await previewBannerSourcePublication(
            database,
            report,
            baseline,
            identityMap,
            publicationFields,
            familyTimingInput ?? undefined,
          );
          if (publicationAcceptance && actorId)
            publication = await publishBannerSourceValues(
              database,
              actorId,
              report,
              baseline,
              publicationAcceptance,
            );
        } else {
          databaseIdentityPreview = await previewBannerSourceIdentities(
            database,
            report,
            baseline,
            identityMap,
          );
          if (acceptance && actorId)
            identityRegistration = await registerBannerSourceIdentities(
              database,
              actorId,
              report,
              baseline,
              acceptance,
            );
        }
      } finally {
        await database.$disconnect();
      }
    }
    const comparison = baseline
      ? compareJpBannerEvidence(report, baseline)
      : null;
    const status =
      comparison?.comparisonLimited ||
      draftValidation?.heldRows ||
      identityPreview?.heldMappings ||
      databaseIdentityPreview?.mappings.some(
        (mapping) => mapping.registrationStatus === "HELD",
      ) ||
      publicationPreview?.mappings.some(
        (mapping) => mapping.status === "HELD",
      ) ||
      familyTimingPreview?.heldMappings
        ? "partial_failure"
        : report.status;
    console.log(
      JSON.stringify(
        {
          ...report,
          status,
          ...(comparison ? { comparison } : {}),
          ...(draftValidation ? { imageDrafts: draftValidation } : {}),
          ...(identityPreview ? { identityMap: identityPreview } : {}),
          ...(databaseIdentityPreview ? { databaseIdentityPreview } : {}),
          ...(identityRegistration ? { identityRegistration } : {}),
          ...(publicationPreview ? { publicationPreview } : {}),
          ...(publication ? { publication } : {}),
          ...(familyTimingPreview ? { familyTimingPreview } : {}),
        },
        null,
        2,
      ),
    );
    if (status === "partial_failure") process.exitCode = 1;
  }
} catch {
  console.error(
    "Could not inspect JP announcements. Use --help for archive/direct URL modes and request limits. No data was published.",
  );
  process.exitCode = 1;
}
