import type { EventCuration, RewardCuration } from "../../../generated/prisma";
import { ownsField } from "./curation-ownership";
type CompatibleOwnership<T> = Omit<T, "ownedFields"> & {
  ownedFields?: string[];
};

export function effectiveFamily<
  T extends {
    name: string;
    curation?: { active: boolean; name: string } | null;
  },
>(family: T) {
  const { curation, ...source } = family;
  return { ...source, name: curation?.active ? curation.name : source.name };
}

type EventRecord = {
  name: string;
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: "DATE_ONLY" | "EXACT";
  endsAtPrecision: "DATE_ONLY" | "EXACT" | null;
  status: "PROJECTED" | "CURATED" | "OFFICIAL";
  updatedAt: Date;
  curation?: CompatibleOwnership<EventCuration> | null;
};

export function eventIsHidden(event: {
  curation?:
    | (Pick<EventCuration, "active" | "hidden"> & { ownedFields?: string[] })
    | null;
}) {
  return (
    event.curation?.active === true &&
    ownsField(event.curation, "hidden") &&
    event.curation.hidden
  );
}

export function effectiveEvent<T extends EventRecord>(event: T) {
  const { curation, ...source } = event;
  if (!curation?.active) return source;
  return {
    ...source,
    name: ownsField(curation, "name") ? curation.name : source.name,
    startsAt: ownsField(curation, "startsAt")
      ? curation.startsAt
      : source.startsAt,
    endsAt: ownsField(curation, "endsAt") ? curation.endsAt : source.endsAt,
    startsAtPrecision: ownsField(curation, "startsAt")
      ? curation.startsAtPrecision
      : source.startsAtPrecision,
    endsAtPrecision: ownsField(curation, "endsAt")
      ? curation.endsAtPrecision
      : source.endsAtPrecision,
    status:
      ownsField(curation, "startsAt") || ownsField(curation, "endsAt")
        ? ("CURATED" as const)
        : source.status,
    updatedAt: curation.updatedAt,
  };
}

export function rewardDateShift(
  event: {
    startsAt: Date;
    curation?: CompatibleOwnership<EventCuration> | null;
  } | null,
) {
  return event?.curation?.active &&
    ownsField(event.curation, "startsAt") &&
    ownsField(event.curation, "shiftRewardDates") &&
    event.curation.shiftRewardDates
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
  curation?: CompatibleOwnership<RewardCuration> | null;
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
    itemType: ownsField(curation, "itemType")
      ? curation.itemType
      : source.itemType,
    amount: ownsField(curation, "amount") ? curation.amount : source.amount,
    expectedAt: ownsField(curation, "expectedAt")
      ? curation.expectedAt
      : source.expectedAt
        ? new Date(source.expectedAt.getTime() + shiftMs)
        : null,
    nature: ownsField(curation, "nature") ? curation.nature : source.nature,
    eligibility: ownsField(curation, "eligibility")
      ? curation.eligibility
      : source.eligibility,
    defaultIncluded: ownsField(curation, "defaultIncluded")
      ? curation.defaultIncluded
      : source.defaultIncluded,
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
