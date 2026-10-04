import { z } from "zod";

import type { EventDateEvidence } from "../../../generated/prisma";
import { ownsField } from "./curation-ownership";

const precision = z.enum(["EXACT", "DATE_ONLY"]);

// Storage validation is not source verification. Only publication can accept evidence.
export const dateEvidenceSchema = z
  .object({
    sourceKind: z.enum(["GLOBAL_GAME_DATA", "PUBLISHER_ANNOUNCEMENT"]),
    sourceUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      }),
    sourceRecordId: z.string().trim().min(1).max(200),
    sourceRegion: z.literal("NA"),
    retrievedAt: z.date(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmedStartsAt: z.date().nullable(),
    confirmedStartPrecision: precision.nullable(),
    confirmedEndsAt: z.date().nullable(),
    confirmedEndPrecision: precision.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (!value.confirmedStartsAt && !value.confirmedEndsAt) ||
      Boolean(value.confirmedStartsAt) !==
        Boolean(value.confirmedStartPrecision) ||
      Boolean(value.confirmedEndsAt) !== Boolean(value.confirmedEndPrecision) ||
      (value.confirmedStartsAt &&
        value.confirmedEndsAt &&
        value.confirmedEndsAt < value.confirmedStartsAt)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Confirmed dates and precision must form a valid boundary or range.",
      });
    }
  });

export type DateConfirmationEvidence = Pick<
  EventDateEvidence,
  | "id"
  | "sourceKind"
  | "sourceRegion"
  | "confirmedStartsAt"
  | "confirmedStartPrecision"
  | "confirmedEndsAt"
  | "confirmedEndPrecision"
  | "createdAt"
>;
type BoundaryStatus = "OFFICIAL" | "CURATED" | "PROJECTED";

// Evidence is accepted history, not a candidate. A newer boundary supersedes an older one.
export function describeDateConfirmation(
  event: {
    startsAt: Date;
    endsAt: Date | null;
    startsAtPrecision: "EXACT" | "DATE_ONLY";
    endsAtPrecision: "EXACT" | "DATE_ONLY" | null;
    curation?: { active: boolean; ownedFields?: string[] } | null;
  },
  evidence: readonly DateConfirmationEvidence[],
) {
  const ordered = [...evidence].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  function boundary(field: "startsAt" | "endsAt"): BoundaryStatus | null {
    const displayed = event[field];
    if (!displayed) return null;
    if (event.curation?.active && ownsField(event.curation, field))
      return "CURATED";
    const start = field === "startsAt";
    const latest = ordered.find((entry) =>
      start ? entry.confirmedStartsAt : entry.confirmedEndsAt,
    );
    if (
      latest?.sourceRegion !== "NA" ||
      !["GLOBAL_GAME_DATA", "PUBLISHER_ANNOUNCEMENT"].includes(
        latest.sourceKind,
      )
    )
      return "PROJECTED";
    const confirmed = start ? latest.confirmedStartsAt : latest.confirmedEndsAt;
    const confirmedPrecision = start
      ? latest.confirmedStartPrecision
      : latest.confirmedEndPrecision;
    const displayedPrecision = start
      ? event.startsAtPrecision
      : event.endsAtPrecision;
    return confirmed?.getTime() === displayed.getTime() &&
      confirmedPrecision === displayedPrecision
      ? "OFFICIAL"
      : "PROJECTED";
  }
  const startsAt = boundary("startsAt")!;
  const endsAt = boundary("endsAt");
  const statuses = [startsAt, endsAt].filter((value) => value !== null);
  const adjustedBoundary =
    event.curation?.active &&
    (ownsField(event.curation, "startsAt") ||
      ownsField(event.curation, "endsAt"));
  const status: BoundaryStatus =
    adjustedBoundary || statuses.includes("CURATED")
      ? "CURATED"
      : statuses.every((value) => value === "OFFICIAL")
        ? "OFFICIAL"
        : "PROJECTED";
  return { startsAt, endsAt, status };
}
