import type { EventCuration, RewardCuration } from "../../../generated/prisma";

type EventRecord = {
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: "DATE_ONLY" | "EXACT";
  endsAtPrecision: "DATE_ONLY" | "EXACT" | null;
  status: "PROJECTED" | "CURATED" | "OFFICIAL";
  updatedAt: Date;
  curation?: EventCuration | null;
};

export function eventIsHidden(event: {
  curation?: Pick<EventCuration, "active" | "hidden"> | null;
}) {
  return event.curation?.active === true && event.curation.hidden;
}

export function effectiveEvent<T extends EventRecord>(event: T) {
  const { curation, ...source } = event;
  if (!curation?.active) return source;
  return {
    ...source,
    name: curation.name,
    startsAt: curation.startsAt,
    endsAt: curation.endsAt,
    startsAtPrecision: curation.startsAtPrecision,
    endsAtPrecision: curation.endsAtPrecision,
    status: "CURATED" as const,
    updatedAt: curation.updatedAt,
  };
}

export function rewardDateShift(
  event: { startsAt: Date; curation?: EventCuration | null } | null,
) {
  return event?.curation?.active && event.curation.shiftRewardDates
    ? event.curation.startsAt.getTime() - event.startsAt.getTime()
    : 0;
}

type RewardRecord = {
  itemType: string;
  amount: number;
  expectedAt: Date | null;
  nature: string;
  eligibility: string | null;
  defaultIncluded: boolean;
  reviewedAt: Date | null;
  curation?: RewardCuration | null;
};

export function effectiveReward<T extends RewardRecord>(
  reward: T,
  shiftMs = 0,
) {
  const { curation, ...source } = reward;
  if (!curation?.active)
    return {
      ...source,
      expectedAt: source.expectedAt
        ? new Date(source.expectedAt.getTime() + shiftMs)
        : null,
    };
  return {
    ...source,
    itemType: curation.itemType,
    amount: curation.amount,
    expectedAt: curation.expectedAt,
    nature: curation.nature,
    eligibility: curation.eligibility,
    defaultIncluded: curation.defaultIncluded,
  };
}

export function overlapsRange(
  entry: { startsAt: Date; endsAt: Date | null },
  from: Date,
  to: Date,
) {
  return (
    entry.startsAt <= to &&
    (entry.endsAt ? entry.endsAt >= from : entry.startsAt >= from)
  );
}
