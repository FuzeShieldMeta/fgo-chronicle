import type { Prisma } from "../../../generated/prisma";

export const publicEventGlobalBaselineSelect = {
  select: {
    name: true,
    startsAt: true,
    endsAt: true,
    startsAtPrecision: true,
    endsAtPrecision: true,
    sourceUrl: true,
    retrievedAt: true,
    updatedAt: true,
  },
} satisfies Prisma.Event$globalBaselineArgs;

export const publicDateEvidenceSelect = {
  select: {
    id: true,
    sourceKind: true,
    sourceRegion: true,
    confirmedStartsAt: true,
    confirmedStartPrecision: true,
    confirmedEndsAt: true,
    confirmedEndPrecision: true,
    createdAt: true,
  },
} satisfies Prisma.Event$dateEvidenceArgs;

export const publicRewardGlobalBaselineSelect = {
  select: {
    itemType: true,
    amount: true,
    expectedAt: true,
    eventStartsAt: true,
    nature: true,
    eligibility: true,
    defaultIncluded: true,
  },
} satisfies Prisma.RewardDefinition$globalBaselineArgs;
