import { z } from "zod";

import { summonSpendInputSchema } from "~/app/timeline/_lib/summon-cost";

const calendarDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const safeCount = z.number().int().nonnegative().safe();

const calendarDaySchema = z
  .string()
  .regex(calendarDayPattern)
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
    "Enter a valid calendar date.",
  );

const summonSpendingSchema = summonSpendInputSchema
  .omit({ startingBonusCount: true })
  .refine(
    ({ multis, quartzSingles, tickets }) =>
      multis + quartzSingles + tickets > 0,
    "Add at least one summon.",
  );

const summonSessionDraftSchema = z.object({
  day: calendarDaySchema,
  status: z.enum(["PLANNED", "SPENT"]),
  banner: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    lineupKey: z.string().trim().min(1),
  }),
  target: z.object({
    servantId: z.number().int().positive().nullable(),
    name: z.string().trim().min(1),
    startingNp: z.number().int().min(0).max(5),
    rate: z.number().finite().gt(0).max(1),
    rateKind: z.enum(["SOURCED", "STANDARD_PRESET", "CUSTOM"]),
    rateEvidenceUrl: z.string().url().nullable(),
    guaranteedEligible: z.boolean(),
  }),
  startingGuaranteedCount: z.number().int().min(0).max(329),
  startingBonusCount: z.number().int().min(0).max(9),
  spending: summonSpendingSchema,
  result: z
    .object({
      targetCopies: safeCount,
    })
    .nullable(),
});

export const summonSessionSchema = summonSessionDraftSchema.extend({
  id: z.string().trim().min(1),
  version: z.literal(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SummonSessionDraft = z.infer<typeof summonSessionDraftSchema>;
export type SummonSession = z.infer<typeof summonSessionSchema>;
export type SummonSessionStatus = SummonSession["status"];

export const summonSessionsStorageKey = "fgo-chronicle:summon-sessions:v1";

type SessionIdentity = {
  id?: string;
  now?: string;
};

function newId() {
  return globalThis.crypto.randomUUID();
}

function currentTime() {
  return new Date().toISOString();
}

export function parseSummonSession(value: unknown): SummonSession | null {
  const result = summonSessionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function createSummonSession(
  value: SummonSessionDraft,
  identity: SessionIdentity = {},
): SummonSession {
  const draft = summonSessionDraftSchema.parse(value);
  const now = identity.now ?? currentTime();
  return summonSessionSchema.parse({
    ...draft,
    id: identity.id ?? newId(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function findSession(sessions: SummonSession[], id: string) {
  const session = sessions.find((candidate) => candidate.id === id);
  if (!session) throw new RangeError("Summon session not found.");
  return session;
}

export function updateSummonSession(
  sessions: SummonSession[],
  id: string,
  changes: Partial<SummonSessionDraft>,
  updatedAt = currentTime(),
) {
  const current = findSession(sessions, id);
  const updated = summonSessionSchema.parse({
    ...current,
    ...changes,
    id: current.id,
    version: current.version,
    createdAt: current.createdAt,
    updatedAt,
  });
  return sessions.map((session) => (session.id === id ? updated : session));
}

export function duplicateSummonSession(
  sessions: SummonSession[],
  id: string,
  identity: SessionIdentity = {},
) {
  const source = findSession(sessions, id);
  const duplicate = createSummonSession(
    {
      day: source.day,
      status: source.status,
      banner: source.banner,
      target: source.target,
      startingGuaranteedCount: source.startingGuaranteedCount,
      startingBonusCount: source.startingBonusCount,
      spending: source.spending,
      result: source.result,
    },
    identity,
  );
  return [...sessions, duplicate];
}

export function moveSummonSession(
  sessions: SummonSession[],
  id: string,
  day: string,
  updatedAt = currentTime(),
) {
  return updateSummonSession(sessions, id, { day }, updatedAt);
}

export function setSummonSessionStatus(
  sessions: SummonSession[],
  id: string,
  status: SummonSessionStatus,
  updatedAt = currentTime(),
) {
  return updateSummonSession(sessions, id, { status }, updatedAt);
}

export function deleteSummonSession(sessions: SummonSession[], id: string) {
  findSession(sessions, id);
  return sessions.filter((session) => session.id !== id);
}

export type LoadedSummonSessions = {
  sessions: SummonSession[];
  warnings: string[];
};

export function loadSummonSessions(storage: Storage): LoadedSummonSessions {
  try {
    const stored = storage.getItem(summonSessionsStorageKey);
    if (!stored) return { sessions: [], warnings: [] };

    const envelope = JSON.parse(stored) as unknown;
    if (
      !envelope ||
      typeof envelope !== "object" ||
      (envelope as { version?: unknown }).version !== 1 ||
      !Array.isArray((envelope as { sessions?: unknown }).sessions)
    ) {
      return {
        sessions: [],
        warnings: ["Saved summon sessions could not be loaded."],
      };
    }

    const sessions: SummonSession[] = [];
    const warnings: string[] = [];
    for (const value of (envelope as { sessions: unknown[] }).sessions) {
      const session = parseSummonSession(value);
      if (session) sessions.push(session);
      else warnings.push("One saved summon session could not be loaded.");
    }
    return { sessions, warnings };
  } catch {
    return {
      sessions: [],
      warnings: ["Saved summon sessions could not be loaded."],
    };
  }
}

export function saveSummonSessions(
  storage: Storage,
  sessions: SummonSession[],
) {
  const valid = sessions.map((session) => summonSessionSchema.parse(session));
  storage.setItem(
    summonSessionsStorageKey,
    JSON.stringify({ version: 1, sessions: valid }),
  );
}
