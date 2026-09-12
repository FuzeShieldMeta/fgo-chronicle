import { z } from "zod";
import { recurringIncomeRules } from "~/app/timeline/_lib/recurring-income-rules";

export const forecastResourceTypes = [
  "SAINT_QUARTZ",
  "SUMMON_TICKET",
  "SAINT_QUARTZ_FRAGMENT",
  "HOLY_GRAIL",
  "CRYSTALLIZED_LORE",
] as const;

export type ForecastResourceType = (typeof forecastResourceTypes)[number];

export type ForecastBalances = Record<ForecastResourceType, number>;

const calendarDayPattern = /^\d{4}-\d{2}-\d{2}$/;

const forecastBalancesSchema = z.object(
  Object.fromEntries(
    forecastResourceTypes.map((type) => [type, z.number().int().nonnegative()]),
  ) as Record<ForecastResourceType, z.ZodNumber>,
);

export const playerForecastProfileSchema = z.object({
  version: z.literal(2),
  storyProgress: z
    .object({
      mainWarId: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .transform((id) => (id === 0 ? null : id)),
      optionalWarIds: z.array(z.number().int().positive()),
    })
    .optional(),
  snapshot: z.object({
    effectiveDate: z
      .string()
      .regex(calendarDayPattern)
      .refine(
        (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
        "Enter a valid calendar date.",
      ),
    balances: forecastBalancesSchema,
  }),
  cumulativeLoginCount: z.number().int().nonnegative(),
  consecutiveLoginDay: z.number().int().min(1).max(7).nullable(),
  includeMonthlyManaPrismTickets: z.boolean(),
  includeWeeklyMasterMissions: z.boolean(),
});

export type PlayerForecastProfile = z.infer<typeof playerForecastProfileSchema>;

export const playerForecastStorageKey = "fgo-chronicle:forecast-profile:v2";
const versionOnePlayerForecastStorageKey = "fgo-chronicle:forecast-profile:v1";

export const emptyForecastBalances: ForecastBalances = {
  SAINT_QUARTZ: 0,
  SUMMON_TICKET: 0,
  SAINT_QUARTZ_FRAGMENT: 0,
  HOLY_GRAIL: 0,
  CRYSTALLIZED_LORE: 0,
};

export function createDefaultPlayerForecastProfile(
  currentDay: string,
): PlayerForecastProfile {
  return {
    version: 2,
    snapshot: {
      effectiveDate: currentDay,
      balances: { ...emptyForecastBalances },
    },
    cumulativeLoginCount: 100,
    consecutiveLoginDay: null,
    includeMonthlyManaPrismTickets: true,
    includeWeeklyMasterMissions: true,
  };
}

export function parsePlayerForecastProfile(
  value: unknown,
): PlayerForecastProfile | null {
  const result = playerForecastProfileSchema.safeParse(value);
  return result.success ? result.data : null;
}

function migrateDraftVersionTwoPlayerForecastProfile(
  value: unknown,
): PlayerForecastProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    version?: unknown;
    snapshot?: unknown;
    cumulativeLoginCount?: unknown;
    consecutiveLoginDay?: unknown;
    monthlyManaPrismTickets?: unknown;
    includeWeeklyMasterMissions?: unknown;
  };
  if (candidate.version !== 2) return null;
  const ticketQuantity = z
    .number()
    .int()
    .min(0)
    .max(recurringIncomeRules.monthlyManaPrismExchange.maximumTickets)
    .safeParse(candidate.monthlyManaPrismTickets);
  if (!ticketQuantity.success) return null;

  return parsePlayerForecastProfile({
    version: 2,
    snapshot: candidate.snapshot,
    cumulativeLoginCount: candidate.cumulativeLoginCount,
    consecutiveLoginDay: candidate.consecutiveLoginDay,
    includeMonthlyManaPrismTickets: ticketQuantity.data > 0,
    includeWeeklyMasterMissions: candidate.includeWeeklyMasterMissions,
  });
}

function migrateVersionOnePlayerForecastProfile(
  value: unknown,
): PlayerForecastProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    version?: unknown;
    snapshot?: unknown;
    cumulativeLoginCount?: unknown;
  };
  if (candidate.version !== 1) return null;

  const defaultProfile = createDefaultPlayerForecastProfile(
    new Date().toISOString().slice(0, 10),
  );
  return parsePlayerForecastProfile({
    ...defaultProfile,
    snapshot: candidate.snapshot,
    cumulativeLoginCount:
      candidate.cumulativeLoginCount === null
        ? defaultProfile.cumulativeLoginCount
        : candidate.cumulativeLoginCount,
  });
}

export function loadPlayerForecastProfile(storage: Storage) {
  try {
    const value = storage.getItem(playerForecastStorageKey);
    if (value) {
      const parsedValue: unknown = JSON.parse(value);
      return (
        parsePlayerForecastProfile(parsedValue) ??
        migrateDraftVersionTwoPlayerForecastProfile(parsedValue)
      );
    }

    const versionOneValue = storage.getItem(versionOnePlayerForecastStorageKey);
    return versionOneValue
      ? migrateVersionOnePlayerForecastProfile(JSON.parse(versionOneValue))
      : null;
  } catch {
    return null;
  }
}

export function savePlayerForecastProfile(
  storage: Storage,
  profile: PlayerForecastProfile,
) {
  storage.setItem(playerForecastStorageKey, JSON.stringify(profile));
}

export function clearPlayerForecastProfile(storage: Storage) {
  storage.removeItem(playerForecastStorageKey);
  storage.removeItem(versionOnePlayerForecastStorageKey);
}
