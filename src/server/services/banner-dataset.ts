import { z } from "zod";
import { BANNER_SYNC_LIMITS as LIMITS } from "~/shared/banner-sync-config.mjs";

const text = z.string().trim().min(1).max(LIMITS.maxTextCharacters);
const id = z.number().int().positive().max(2_147_483_647);
const instant = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Invalid timestamp offset.",
  );
const featured = z.object({
  id,
  name: text,
  class: text,
  rarity: z.number().int().min(0).max(5).nullable().optional(),
  faceId: id.nullable().optional(),
  soloRateUp: z.boolean(),
});
const lineup = z.object({
  sourceKey: text,
  name: text,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  evidenceUrl: z.string().url(),
  sourceRegion: text,
  lastVerifiedAt: z.string().datetime().nullable().optional(),
  servants: z
    .array(z.object({ servantId: id, soloRateUp: z.boolean() }))
    .max(LIMITS.maxFeaturedServants),
});
const common = {
  name: text,
  status: z.enum(["PROJECTED", "CONFIRMED_EN", "OFFICIAL", "CURATED"]),
  sourceSchedule: z.enum(["JP", "NA"]),
  servants: z.array(featured).min(1).max(LIMITS.maxFeaturedServants),
  summonLineups: z.array(lineup).max(LIMITS.maxLineupsPerBanner).optional(),
};
export const spreadsheetBannerSchema = z
  .object({
    ...common,
    startDate: z.string().date(),
    endDate: z.string().date().nullable(),
  })
  .strict();
const exactBanner = z
  .object({
    ...common,
    sourceKey: text,
    sourceUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Evidence requires a credential-free HTTPS URL."),
    startsAt: instant,
    endsAt: instant.nullable(),
    timePrecision: z.literal("EXACT"),
  })
  .strict();
const banner = z
  .union([spreadsheetBannerSchema, exactBanner])
  .superRefine((value, ctx) => {
    const start =
      "startsAt" in value
        ? Date.parse(value.startsAt)
        : Date.parse(value.startDate);
    const endValue = "endsAt" in value ? value.endsAt : value.endDate;
    if (endValue && Date.parse(endValue) < start)
      ctx.addIssue({ code: "custom", message: "Invalid banner date range." });
    if (
      (value.status === "CONFIRMED_EN" || value.status === "OFFICIAL") &&
      value.sourceSchedule !== "NA"
    )
      ctx.addIssue({
        code: "custom",
        message: "Official banners require Global source dates.",
      });
    if (
      "sourceKey" in value &&
      (!value.sourceKey.startsWith(`publisher:${value.sourceSchedule}:`) ||
        value.sourceKey.length <= `publisher:${value.sourceSchedule}:`.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Exact banners require a region-qualified publisher identity.",
      });
    if (
      new Set(value.servants.map((servant) => servant.id)).size !==
      value.servants.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate featured servant." });
    for (const item of value.summonLineups ?? []) {
      if (item.endsAt && item.endsAt < item.startsAt)
        ctx.addIssue({ code: "custom", message: "Invalid lineup date range." });
      if (
        item.servants.some(
          (servant) =>
            !value.servants.some((feature) => feature.id === servant.servantId),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Lineup servant is not featured in this banner.",
        });
    }
    if (
      new Set(value.summonLineups?.map((item) => item.sourceKey)).size !==
      (value.summonLineups?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate lineup source key." });
  });

/** Legacy spreadsheet identity. Do not generate announcement identities from names or dates. */
export function bannerSourceKey(
  value:
    | { name: string; startDate: string; endDate: string | null }
    | { sourceKey: string },
) {
  if ("sourceKey" in value) return value.sourceKey;
  return [
    value.name.trim().toLowerCase(),
    value.startDate,
    value.endDate ?? "",
  ].join(":");
}
export const bannerDatasetSchema = z
  .object({
    importedAt: z.string().datetime().optional(),
    banners: z.array(banner).min(1).max(LIMITS.maxBanners),
  })
  .superRefine((value, ctx) => {
    if (
      value.banners.reduce(
        (count, banner) => count + banner.servants.length,
        0,
      ) > LIMITS.maxFeaturedMemberships ||
      value.banners.reduce(
        (count, banner) => count + (banner.summonLineups?.length ?? 0),
        0,
      ) > LIMITS.maxTotalLineups
    )
      ctx.addIssue({
        code: "custom",
        message: "Banner dataset exceeds publication limits.",
      });
    if (
      new Set(value.banners.map(bannerSourceKey)).size !== value.banners.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate banner source key." });
  });
export type BannerDataset = z.infer<typeof bannerDatasetSchema>;

/** Canonical UTC instants prevent offset loss when writing timestamp-without-time-zone columns. */
export function bannerPublicationTiming(
  banner: BannerDataset["banners"][number],
) {
  return "startsAt" in banner
    ? {
        startsAt: new Date(banner.startsAt).toISOString(),
        endsAt: banner.endsAt ? new Date(banner.endsAt).toISOString() : null,
        startsAtPrecision: "EXACT" as const,
        endsAtPrecision: banner.endsAt ? ("EXACT" as const) : null,
        sourceUrl: banner.sourceUrl,
      }
    : {
        startsAt: `${banner.startDate}T00:00:00Z`,
        endsAt: banner.endDate ? `${banner.endDate}T00:00:00Z` : null,
        startsAtPrecision: "DATE_ONLY" as const,
        endsAtPrecision: banner.endDate ? ("DATE_ONLY" as const) : null,
        sourceUrl: null,
      };
}
