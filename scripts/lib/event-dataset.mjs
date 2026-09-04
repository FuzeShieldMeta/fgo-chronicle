import { z } from "zod";

const nullableDate = z.string().datetime().nullable();
const sourceKey = z.string().trim().min(1);

const evidenceSourceSchema = z.object({
  sourceKey,
  type: z.enum(["ATLAS_ACADEMY", "OFFICIAL_ANNOUNCEMENT", "WIKI", "CURATED"]),
  region: z.string().trim().min(1),
  url: z.string().url(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().trim().min(1).nullable(),
});

const familySchema = z.object({
  sourceKey,
  name: z.string().trim().min(1),
  artworkUrl: z.string().url().nullable(),
  artworkSourceUrl: z.string().url().nullable(),
  artworkAlt: z.string().trim().min(1).nullable(),
  artworkReviewedAt: nullableDate,
});

const eventSchema = z
  .object({
    sourceKey,
    familySourceKey: sourceKey.nullable(),
    evidenceSourceKey: sourceKey,
    name: z.string().trim().min(1),
    type: z.enum([
      "MAIN_EVENT",
      "PRE_RELEASE_CAMPAIGN",
      "LOGIN_BONUS",
      "CAMPAIGN",
      "EVENT_SHOP",
      "QUEST_RELEASE",
      "LIMITED_MISSION",
      "MAINTENANCE",
      "OTHER",
    ]),
    startsAt: z.string().datetime(),
    startsAtPrecision: z.enum(["DATE_ONLY", "EXACT"]),
    endsAt: nullableDate,
    endsAtPrecision: z.enum(["DATE_ONLY", "EXACT"]).nullable(),
    status: z.enum(["PROJECTED", "CURATED", "OFFICIAL"]),
    sourceUrl: z.string().url(),
    sourceRegion: z.string().trim().min(1),
    sourceStartsAt: nullableDate.optional(),
    sourceEndsAt: nullableDate.optional(),
    projectionMethod: z.enum(["TWO_CALENDAR_YEARS"]).nullable().optional(),
    lastSyncedAt: nullableDate.optional(),
    sourceContentHash: z.string().trim().min(1).nullable().optional(),
  })
  .refine(
    ({ startsAt, endsAt }) =>
      endsAt === null || new Date(endsAt) >= new Date(startsAt),
    { message: "An event cannot end before it starts.", path: ["endsAt"] },
  )
  .refine(
    ({ endsAt, endsAtPrecision }) => endsAt !== null || endsAtPrecision == null,
    {
      message: "An event without an end time cannot have end-time precision.",
      path: ["endsAtPrecision"],
    },
  )
  .refine(
    ({ endsAt, endsAtPrecision }) =>
      endsAt === null || endsAtPrecision !== null,
    {
      message: "An event with an end time must declare its end-time precision.",
      path: ["endsAtPrecision"],
    },
  );

const rewardSchema = z.object({
  sourceKey,
  itemType: z.enum([
    "SAINT_QUARTZ",
    "SAINT_QUARTZ_FRAGMENT",
    "SUMMON_TICKET",
    "CRYSTALLIZED_LORE",
    "HOLY_GRAIL",
  ]),
  amount: z.number().int().positive(),
  expectedAt: nullableDate,
  nature: z.enum(["DETERMINISTIC", "CONDITIONAL", "CURATED_ESTIMATE"]),
  eligibility: z.string().trim().min(1).nullable(),
  defaultIncluded: z.boolean(),
  reviewedAt: nullableDate.optional().default(null),
});

const rewardSourceSchema = z.object({
  sourceKey,
  eventSourceKey: sourceKey.nullable(),
  evidenceSourceKey: sourceKey,
  name: z.string().trim().min(1),
  type: z.enum([
    "LOGIN_BONUS",
    "PRE_CAMPAIGN",
    "EVENT_SHOP",
    "POINT_REWARD",
    "QUEST_CLEAR",
    "CHALLENGE_QUEST",
    "LIMITED_MISSION",
    "MASTER_MISSION",
    "SOCIAL_CAMPAIGN",
    "MAINTENANCE",
    "LOGIN_MILESTONE",
    "OTHER",
  ]),
  status: z.enum(["PROJECTED", "CURATED", "OFFICIAL"]),
  evidenceUrl: z.string().url(),
  lastVerifiedAt: nullableDate,
  rewards: z.array(rewardSchema).min(1),
});

const reviewIssueSchema = z.object({
  sourceKey,
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  message: z.string().trim().min(1),
});

const eventDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    review: z.object({
      status: z.enum(["NEEDS_REVIEW", "APPROVED"]),
      reviewedAt: nullableDate,
      note: z.string().trim().min(1).nullable(),
    }),
    sources: z.array(evidenceSourceSchema).min(1),
    families: z.array(familySchema),
    events: z.array(eventSchema),
    rewardSources: z.array(rewardSourceSchema),
    issues: z.array(reviewIssueSchema),
  })
  .superRefine((dataset, ctx) => {
    /**
     * @param {{sourceKey: string}[]} values
     * @param {string} path
     */
    const keysAreUnique = (values, path) => {
      const seen = new Set();
      values.forEach(({ sourceKey: key }, index) => {
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate source key: ${key}`,
            path: [path, index, "sourceKey"],
          });
        }
        seen.add(key);
      });
      return seen;
    };

    const sourceKeys = keysAreUnique(dataset.sources, "sources");
    const familyKeys = keysAreUnique(dataset.families, "families");
    const eventKeys = keysAreUnique(dataset.events, "events");
    keysAreUnique(dataset.rewardSources, "rewardSources");

    dataset.events.forEach((event, index) => {
      if (event.familySourceKey && !familyKeys.has(event.familySourceKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown event family: ${event.familySourceKey}`,
          path: ["events", index, "familySourceKey"],
        });
      }
      if (!sourceKeys.has(event.evidenceSourceKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown evidence source: ${event.evidenceSourceKey}`,
          path: ["events", index, "evidenceSourceKey"],
        });
      }
    });

    dataset.rewardSources.forEach((source, index) => {
      if (source.eventSourceKey && !eventKeys.has(source.eventSourceKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown event: ${source.eventSourceKey}`,
          path: ["rewardSources", index, "eventSourceKey"],
        });
      }
      if (!sourceKeys.has(source.evidenceSourceKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown evidence source: ${source.evidenceSourceKey}`,
          path: ["rewardSources", index, "evidenceSourceKey"],
        });
      }
    });

    if (dataset.review.status === "APPROVED" && !dataset.review.reviewedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An approved dataset must have a review date.",
        path: ["review", "reviewedAt"],
      });
    }
  });

/** @param {unknown} value */
export function parseEventDataset(value) {
  return eventDatasetSchema.parse(value);
}

/** @param {unknown} value */
export function parseApprovedEventDataset(value) {
  const dataset = parseEventDataset(value);
  if (dataset.review.status !== "APPROVED") {
    throw new Error(
      "Event dataset requires review before database import. Set review.status to APPROVED after checking its sources and issues.",
    );
  }
  if (dataset.issues.some(({ severity }) => severity === "ERROR")) {
    throw new Error(
      "An approved event dataset cannot contain unresolved errors.",
    );
  }
  return dataset;
}
