import type { EventCuration, RewardCuration } from "../../../generated/prisma";
import { ownsField } from "./curation-ownership";
import {
  describeDateConfirmation,
  type DateConfirmationEvidence,
} from "./date-confirmation";
type CompatibleOwnership<T> = Omit<T, "ownedFields"> & {
  ownedFields?: string[];
};

export type ScheduleDateOverlay = {
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: "EXACT" | "DATE_ONLY";
  endsAtPrecision: "EXACT" | "DATE_ONLY" | null;
  startStatus: "OFFICIAL" | "CURATED" | "PROJECTED";
  endStatus: "OFFICIAL" | "CURATED" | "PROJECTED" | null;
  curationRevision?: number;
  curationStartsAt?: Date | null;
  curationEndsAt?: Date | null;
  curationStartPrecision?: "EXACT" | "DATE_ONLY" | null;
  curationEndPrecision?: "EXACT" | "DATE_ONLY" | null;
  sourceUrl: string;
  retrievedAt: Date;
  updatedAt: Date;
};

function scheduleStatus(
  start: ScheduleDateOverlay["startStatus"],
  end: ScheduleDateOverlay["endStatus"],
) {
  const statuses = [start, end].filter((value) => value !== null);
  return statuses.every((value) => value === "OFFICIAL")
    ? ("OFFICIAL" as const)
    : statuses.includes("CURATED")
      ? ("CURATED" as const)
      : ("PROJECTED" as const);
}

export function effectiveBanner<
  T extends {
    startsAt: Date;
    endsAt: Date | null;
    startsAtPrecision: "EXACT" | "DATE_ONLY";
    endsAtPrecision: "EXACT" | "DATE_ONLY" | null;
    status: "OFFICIAL" | "CURATED" | "PROJECTED";
    updatedAt: Date;
    dateOverlay?: ScheduleDateOverlay | null;
  },
>(banner: T) {
  const { dateOverlay, ...source } = banner;
  if (!dateOverlay) return source;
  return {
    ...source,
    startsAt: dateOverlay.startsAt,
    endsAt: dateOverlay.endsAt,
    startsAtPrecision: dateOverlay.startsAtPrecision,
    endsAtPrecision: dateOverlay.endsAtPrecision,
    status: scheduleStatus(dateOverlay.startStatus, dateOverlay.endStatus),
    updatedAt: new Date(
      Math.max(source.updatedAt.getTime(), dateOverlay.updatedAt.getTime()),
    ),
  };
}

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
  globalBaseline?: {
    name: string;
    startsAt: Date;
    endsAt: Date | null;
    startsAtPrecision: "DATE_ONLY" | "EXACT";
    endsAtPrecision: "DATE_ONLY" | "EXACT" | null;
    sourceUrl: string;
    retrievedAt: Date;
    updatedAt: Date;
  } | null;
  dateEvidence?: DateConfirmationEvidence[];
  dateOverlay?: ScheduleDateOverlay | null;
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
  const { curation, globalBaseline, dateEvidence, dateOverlay, ...imported } =
    event;
  const source = {
    ...imported,
    ...(globalBaseline
      ? {
          name: globalBaseline.name,
          startsAt: globalBaseline.startsAt,
          endsAt: globalBaseline.endsAt,
          startsAtPrecision: globalBaseline.startsAtPrecision,
          endsAtPrecision: globalBaseline.endsAtPrecision,
          updatedAt: new Date(
            Math.max(
              imported.updatedAt.getTime(),
              globalBaseline.updatedAt.getTime(),
            ),
          ),
        }
      : {}),
  };
  const effective = !curation?.active
    ? source
    : {
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
        updatedAt: new Date(
          Math.max(source.updatedAt.getTime(), curation.updatedAt.getTime()),
        ),
      };
  const confirmation =
    globalBaseline || dateEvidence?.length
      ? describeDateConfirmation({ ...effective, curation }, dateEvidence ?? [])
      : {
          status: effective.status,
          startsAt:
            curation?.active && ownsField(curation, "startsAt")
              ? ("CURATED" as const)
              : source.status,
          endsAt: effective.endsAt
            ? curation?.active && ownsField(curation, "endsAt")
              ? ("CURATED" as const)
              : source.status
            : null,
        };
  const useStart =
    dateOverlay &&
    (dateOverlay.startStatus === "OFFICIAL" ||
      !(
        curation?.active &&
        ownsField(curation, "startsAt") &&
        curation.revision > (dateOverlay.curationRevision ?? 0) &&
        (curation.startsAt.getTime() !==
          dateOverlay.curationStartsAt?.getTime() ||
          curation.startsAtPrecision !== dateOverlay.curationStartPrecision)
      ));
  const useEnd =
    dateOverlay &&
    (dateOverlay.endStatus === "OFFICIAL" ||
      !(
        curation?.active &&
        ownsField(curation, "endsAt") &&
        curation.revision > (dateOverlay.curationRevision ?? 0) &&
        (curation.endsAt?.getTime() !== dateOverlay.curationEndsAt?.getTime() ||
          curation.endsAtPrecision !== dateOverlay.curationEndPrecision)
      ));
  if (dateOverlay) {
    if (useStart) confirmation.startsAt = dateOverlay.startStatus;
    if (useEnd) confirmation.endsAt = dateOverlay.endStatus;
    confirmation.status = scheduleStatus(
      confirmation.startsAt,
      confirmation.endsAt,
    );
  }
  return {
    ...effective,
    ...(dateOverlay
      ? {
          ...(useStart
            ? {
                startsAt: dateOverlay.startsAt,
                startsAtPrecision: dateOverlay.startsAtPrecision,
              }
            : {}),
          ...(useEnd
            ? {
                endsAt: dateOverlay.endsAt,
                endsAtPrecision: dateOverlay.endsAtPrecision,
              }
            : {}),
          updatedAt: new Date(
            Math.max(
              effective.updatedAt.getTime(),
              dateOverlay.updatedAt.getTime(),
            ),
          ),
        }
      : {}),
    status: confirmation.status,
    dateConfirmation: confirmation,
    globalSourceUrl:
      dateOverlay?.sourceUrl ?? globalBaseline?.sourceUrl ?? null,
    globalRetrievedAt:
      dateOverlay?.retrievedAt ?? globalBaseline?.retrievedAt ?? null,
  };
}

export function rewardDateShift(
  event: {
    startsAt: Date;
    curation?: CompatibleOwnership<EventCuration> | null;
    dateOverlay?: ScheduleDateOverlay | null;
  } | null,
  reward?: Pick<RewardRecord, "expectedAt" | "globalBaseline" | "dateBasis">,
) {
  // A confirmed distribution or independently dated reward stays in its family,
  // but its payment date is not relative to that family's opening.
  if (reward?.dateBasis === "ABSOLUTE") return 0;
  if (event?.dateOverlay) {
    if (
      event.dateOverlay.startStatus === "OFFICIAL" ||
      !event.curation?.active ||
      event.curation.revision <= (event.dateOverlay.curationRevision ?? 0) ||
      (event.curation.startsAt.getTime() ===
        event.dateOverlay.curationStartsAt?.getTime() &&
        event.curation.startsAtPrecision ===
          event.dateOverlay.curationStartPrecision)
    )
      return 0;
    return ownsField(event.curation, "startsAt") &&
      ownsField(event.curation, "shiftRewardDates") &&
      event.curation.shiftRewardDates
      ? event.curation.startsAt.getTime() - event.dateOverlay.startsAt.getTime()
      : 0;
  }
  return event?.curation?.active &&
    ownsField(event.curation, "startsAt") &&
    ownsField(event.curation, "shiftRewardDates") &&
    event.curation.shiftRewardDates
    ? event.curation.startsAt.getTime() -
        (reward?.globalBaseline?.eventStartsAt ?? event.startsAt).getTime()
    : 0;
}

type RewardRecord = {
  dateBasis?: "UNKNOWN" | "EVENT_END" | "START_RELATIVE" | "ABSOLUTE";
  itemType: string;
  amount: number;
  expectedAt: Date | null;
  nature: string;
  eligibility: string | null;
  defaultIncluded: boolean;
  reviewedAt: Date | null;
  dateOverlay?: { expectedAt: Date | null } | null;
  curation?: CompatibleOwnership<RewardCuration> | null;
  globalBaseline?: {
    itemType: string;
    amount: number;
    expectedAt: Date | null;
    eventStartsAt: Date;
    nature: string;
    eligibility: string | null;
    defaultIncluded: boolean;
  } | null;
};

export function effectiveReward<T extends RewardRecord>(
  reward: T,
  shiftMs = 0,
) {
  const { curation, globalBaseline, dateOverlay, ...imported } = reward;
  const source = {
    ...imported,
    ...(globalBaseline
      ? {
          itemType: globalBaseline.itemType,
          amount: globalBaseline.amount,
          expectedAt: globalBaseline.expectedAt,
          nature: globalBaseline.nature,
          eligibility: globalBaseline.eligibility,
          defaultIncluded: globalBaseline.defaultIncluded,
        }
      : {}),
    ...(dateOverlay ? { expectedAt: dateOverlay.expectedAt } : {}),
  };
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
