import { createHash } from "node:crypto";

type Precision = "EXACT" | "DATE_ONLY";
type Status = "OFFICIAL" | "CURATED" | "PROJECTED";

export interface FamilyDateMember {
  id: string;
  kind: "EVENT" | "BANNER";
  startsAt: Date;
  endsAt: Date | null;
  startsAtPrecision: Precision;
  endsAtPrecision: Precision | null;
  confirmation: { startsAt: Status; endsAt: Status | null };
  revision: string;
}

export interface FamilyRewardDate {
  id: string;
  eventId: string;
  expectedAt: Date | null;
  behaviour: "EVENT_RELATIVE" | "ABSOLUTE" | "UNKNOWN";
  ownedDate: boolean;
  revision: string;
}

function validDate(date: Date) {
  return Number.isFinite(date.getTime());
}

function shift(date: Date | null, milliseconds: number) {
  if (!date) return null;
  const next = new Date(date.getTime() + milliseconds);
  if (!validDate(next)) throw new RangeError("The shifted date is invalid.");
  return next;
}

// Read-only calculation. Publication must verify the snapshot and source under locks.
export function calculateOfficialFamilyDates(input: {
  anchorEventId: string;
  confirmedStartsAt: Date | null;
  confirmedEndsAt: Date | null;
  members: readonly FamilyDateMember[];
  rewards: readonly FamilyRewardDate[];
}) {
  const { confirmedStartsAt, confirmedEndsAt } = input;
  if (
    (!confirmedStartsAt && !confirmedEndsAt) ||
    (confirmedStartsAt && !validDate(confirmedStartsAt)) ||
    (confirmedEndsAt && !validDate(confirmedEndsAt)) ||
    (confirmedStartsAt &&
      confirmedEndsAt &&
      confirmedEndsAt < confirmedStartsAt)
  )
    throw new RangeError(
      "Official dates must contain a valid boundary or range.",
    );
  const keys = input.members.map((member) => `${member.kind}:${member.id}`);
  if (new Set(keys).size !== keys.length)
    throw new RangeError("A family member appears more than once.");
  if (
    new Set(input.rewards.map((reward) => reward.id)).size !==
    input.rewards.length
  )
    throw new RangeError("A reward appears more than once.");
  const anchor = input.members.find(
    (member) => member.kind === "EVENT" && member.id === input.anchorEventId,
  );
  if (!anchor)
    throw new RangeError("The anchor must be an event in the family.");
  const offsetMs = confirmedStartsAt
    ? confirmedStartsAt.getTime() - anchor.startsAt.getTime()
    : 0;
  const members = [...input.members]
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
    .map((member) => {
      if (
        !validDate(member.startsAt) ||
        (member.endsAt &&
          (!validDate(member.endsAt) || member.endsAt < member.startsAt)) ||
        (member.endsAt === null) !== (member.endsAtPrecision === null) ||
        (member.endsAt === null) !== (member.confirmation.endsAt === null)
      )
        throw new RangeError("A family member has invalid dates or precision.");
      const isAnchor = member.kind === "EVENT" && member.id === anchor.id;
      const startsAt =
        isAnchor && confirmedStartsAt
          ? new Date(confirmedStartsAt)
          : member.confirmation.startsAt === "OFFICIAL"
            ? new Date(member.startsAt)
            : shift(member.startsAt, offsetMs)!;
      const endsAt =
        isAnchor && confirmedEndsAt
          ? new Date(confirmedEndsAt)
          : member.confirmation.endsAt === "OFFICIAL"
            ? member.endsAt && new Date(member.endsAt)
            : shift(member.endsAt, offsetMs);
      if (endsAt && endsAt < startsAt)
        throw new RangeError(
          "The family move would create an invalid date range.",
        );
      return {
        id: member.id,
        kind: member.kind,
        before: member,
        after: {
          startsAt,
          endsAt,
          startsAtPrecision:
            isAnchor && confirmedStartsAt
              ? ("EXACT" as const)
              : member.startsAtPrecision,
          endsAtPrecision:
            isAnchor && confirmedEndsAt
              ? ("EXACT" as const)
              : member.endsAtPrecision,
          confirmation: {
            startsAt:
              isAnchor && confirmedStartsAt
                ? ("OFFICIAL" as const)
                : member.confirmation.startsAt,
            endsAt:
              isAnchor && confirmedEndsAt
                ? ("OFFICIAL" as const)
                : member.confirmation.endsAt,
          },
        },
        startOffsetMs: startsAt.getTime() - member.startsAt.getTime(),
      };
    });
  const eventOffsets = new Map(
    members
      .filter((member) => member.kind === "EVENT")
      .map((member) => [member.id, member.startOffsetMs]),
  );
  const rewards = [...input.rewards]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((reward) => {
      if (!eventOffsets.has(reward.eventId))
        throw new RangeError(
          "A reward belongs to an event outside the family.",
        );
      if (reward.expectedAt && !validDate(reward.expectedAt))
        throw new RangeError("A reward has an invalid date.");
      const offset =
        reward.behaviour === "EVENT_RELATIVE" && !reward.ownedDate
          ? eventOffsets.get(reward.eventId)!
          : 0;
      return {
        id: reward.id,
        before: reward,
        expectedAt: shift(reward.expectedAt, offset),
      };
    });
  const plan = { anchorEventId: anchor.id, offsetMs, members, rewards };
  return {
    ...plan,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
  };
}
