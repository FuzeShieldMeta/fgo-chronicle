import type { Prisma } from "../../../generated/prisma";

export const publicScheduleDateSelect = {
  startsAt: true,
  endsAt: true,
  startsAtPrecision: true,
  endsAtPrecision: true,
  startStatus: true,
  endStatus: true,
  sourceUrl: true,
  retrievedAt: true,
  updatedAt: true,
} as const;

export const publicEventDateOverlaySelect = {
  select: {
    ...publicScheduleDateSelect,
    curationRevision: true,
    curationStartsAt: true,
    curationEndsAt: true,
    curationStartPrecision: true,
    curationEndPrecision: true,
  },
} satisfies Prisma.Event$dateOverlayArgs;

export const publicBannerDateOverlaySelect = {
  select: publicScheduleDateSelect,
} satisfies Prisma.Banner$dateOverlayArgs;

export const publicRewardDateOverlaySelect = {
  select: { expectedAt: true },
} satisfies Prisma.RewardDefinition$dateOverlayArgs;

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
