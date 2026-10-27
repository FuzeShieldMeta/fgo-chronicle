import { z } from "zod";
import { createHash } from "node:crypto";
import type { inventoryJpBannerAnnouncements } from "./jp-banner-inventory";
import { projectJpBannerPeriods } from "./jp-banner-projection";

export const JP_BANNER_IMAGE_DRAFT_LIMITS = {
  maxFileBytes: 1_024 * 1_024,
  maxImages: 10,
  maxRowsPerImage: 100,
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
function jstMinute(value: string) {
  const time = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(time) &&
    new Date(time + 9 * 3_600_000).toISOString().slice(0, 16) === value
    ? new Date(time).toISOString()
    : null;
}
function boundaryClockMatches(text: string, minute: string) {
  const normalized = text.normalize("NFKC");
  const clocks = [
    ...normalized.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/gu),
  ];
  return (
    clocks.length === 1 &&
    `${clocks[0]![1]!.padStart(2, "0")}:${clocks[0]![2]}` === minute.slice(11)
  );
}
const minute = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
  .refine((value) => jstMinute(value) !== null, "Invalid JST calendar minute.");
const boundary = z
  .object({
    text: z.string().trim().min(1).max(300),
    x: z.number().int().min(0).max(8192),
    y: z.number().int().min(0).max(8192),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
  })
  .strict();
const imageDraft = z
  .object({
    articleUrl: z.string().url(),
    articleContentHash: hash,
    imageUrl: z.string().url(),
    imageContentHash: hash,
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    rows: z
      .array(
        z
          .object({
            rowId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
            label: z.string().trim().min(1).max(200),
            startsAtJst: minute,
            endsAtJst: minute,
            startEvidence: boundary,
            endEvidence: boundary,
          })
          .strict(),
      )
      .min(1)
      .max(JP_BANNER_IMAGE_DRAFT_LIMITS.maxRowsPerImage),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.rows.map((row) => row.rowId)).size !== value.rows.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate draft row identity.",
      });
  });
export const jpBannerImageDraftSchema = z
  .object({
    version: z.literal(1),
    method: z.literal("MANUAL"),
    images: z
      .array(imageDraft)
      .min(1)
      .max(JP_BANNER_IMAGE_DRAFT_LIMITS.maxImages),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(
        value.images.map((image) =>
          JSON.stringify([image.articleUrl, image.imageUrl]),
        ),
      ).size !== value.images.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate source image draft.",
      });
  });

/** Checks consistency only. It cannot verify the text/portraits inside evidence coordinates. */
export function validateJpBannerImageDrafts(
  report: Awaited<ReturnType<typeof inventoryJpBannerAnnouncements>>,
  input: unknown,
) {
  const draft = jpBannerImageDraftSchema.parse(input);
  const images = draft.images.map((image) => {
    const inspection = report.articles.find(
      (article) => article.url === image.articleUrl,
    )?.inspection;
    const inspectedImage = inspection?.imageEvidence?.images.find(
      (candidate) => candidate.url === image.imageUrl,
    )?.evidence;
    const sourceIssues: string[] = [];
    if (!inspection) sourceIssues.push("ARTICLE_NOT_INSPECTED");
    else {
      if (
        inspection.kind !== "SUMMON_CONTENT" ||
        inspection.restrictionEvidence
      )
        sourceIssues.push("ARTICLE_NOT_ELIGIBLE");
      if (inspection.contentHash !== image.articleContentHash)
        sourceIssues.push("ARTICLE_CONTENT_CHANGED");
    }
    if (!inspectedImage) sourceIssues.push("IMAGE_NOT_INSPECTED");
    else {
      if (inspectedImage.contentHash !== image.imageContentHash)
        sourceIssues.push("IMAGE_CONTENT_CHANGED");
      if (
        inspectedImage.width !== image.width ||
        inspectedImage.height !== image.height
      )
        sourceIssues.push("IMAGE_DIMENSIONS_CHANGED");
    }
    const envelopes =
      inspection?.schedule.periods.filter(
        (period) => period.scope === "ARTICLE_ENVELOPE",
      ) ?? [];
    const envelope = envelopes.length === 1 ? envelopes[0] : null;
    if (!envelope?.startsAt || !envelope.endsAt || envelope.issues.length)
      sourceIssues.push("SOURCE_ENVELOPE_UNRESOLVED");
    const anchor = inspection?.naProjection;
    if (!anchor?.jpAnchorDay || !anchor.naAnchorDay || anchor.status === "HELD")
      sourceIssues.push("PROJECTION_ANCHOR_UNAVAILABLE");
    return {
      articleUrl: image.articleUrl,
      imageUrl: image.imageUrl,
      expectedArticleContentHash: image.articleContentHash,
      expectedImageContentHash: image.imageContentHash,
      rows: image.rows.map((row) => {
        const startsAt = jstMinute(row.startsAtJst)!,
          endsAt = jstMinute(row.endsAtJst)!;
        const issues = [...sourceIssues];
        if (endsAt < startsAt) issues.push("REVERSED_DRAFT_WINDOW");
        if (
          envelope?.startsAt &&
          envelope.endsAt &&
          (startsAt < envelope.startsAt || endsAt > envelope.endsAt)
        )
          issues.push("DRAFT_OUTSIDE_SOURCE_ENVELOPE");
        for (const evidence of [row.startEvidence, row.endEvidence]) {
          if (
            /\b(?:UTC|GMT|PDT|PST|EST|EDT|CST|CDT|CET|CEST|KST)\b/iu.test(
              evidence.text,
            )
          )
            issues.push("UNSUPPORTED_BOUNDARY_TIMEZONE");
          if (
            evidence.x + evidence.width > image.width ||
            evidence.y + evidence.height > image.height
          )
            issues.push("EVIDENCE_OUTSIDE_IMAGE");
        }
        if (
          !boundaryClockMatches(row.startEvidence.text, row.startsAtJst) ||
          !boundaryClockMatches(row.endEvidence.text, row.endsAtJst)
        )
          issues.push("BOUNDARY_CLOCK_CONFLICT_OR_UNRESOLVED");
        const projection =
          !issues.length && anchor?.jpAnchorDay && anchor.naAnchorDay
            ? projectJpBannerPeriods(
                [
                  {
                    evidenceHash: createHash("sha256")
                      .update(
                        JSON.stringify([
                          image.articleUrl,
                          image.articleContentHash,
                          image.imageUrl,
                          image.imageContentHash,
                          row,
                        ]),
                      )
                      .digest("hex"),
                    scope: "LABELLED_SUMMON",
                    subject: row.label,
                    label: row.label,
                    context: `${row.startEvidence.text} / ${row.endEvidence.text}`,
                    normalizedPeriod: `${row.startsAtJst}/${row.endsAtJst}`,
                    startsAt,
                    endsAt,
                    timezone: "JST",
                    timezoneBasis: "JP_PUBLISHER_CONVENTION",
                    endYearBasis: "EXPLICIT",
                    issues: [],
                  },
                ],
                anchor.jpAnchorDay,
                anchor.naAnchorDay,
              )[0]!
            : null;
        return {
          draftRowId: row.rowId,
          label: row.label,
          status: issues.length
            ? ("HELD" as const)
            : ("CONSISTENT_REVIEW_REQUIRED" as const),
          issues: [...new Set(issues)],
          draftStartsAt: startsAt,
          draftEndsAt: endsAt,
          startEvidence: row.startEvidence,
          endEvidence: row.endEvidence,
          projection,
          projectionBasis: projection ? anchor!.anchorBasis : null,
          confirmation: "PROJECTED_NOT_CONFIRMED" as const,
          humanReviewRequired: true as const,
          identityConfirmed: false as const,
          rosterComplete: false as const,
          publicationAllowed: false as const,
        };
      }),
    };
  });
  const rows = images.flatMap((image) => image.rows);
  const heldRows = rows.filter((row) => row.status === "HELD").length;
  return {
    scope: "MANUAL_IMAGE_DRAFT_CONSISTENCY_CHECK" as const,
    status:
      heldRows === rows.length
        ? ("HELD" as const)
        : heldRows
          ? ("PARTIAL" as const)
          : ("CONSISTENT_REVIEW_REQUIRED" as const),
    images,
    consistentRows: rows.filter(
      (row) => row.status === "CONSISTENT_REVIEW_REQUIRED",
    ).length,
    heldRows,
    humanReviewRequired: true as const,
    publicationAllowed: false as const,
  };
}
