import type { EventType } from "../../../generated/prisma";
import {
  GLOBAL_ANNOUNCEMENT_MATCHING as RULES,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";
import type {
  AnnouncementPeriod,
  AnnouncementPeriodKind,
} from "./global-announcement-parser";

// A section can confirm only the schedule record it describes.
export const announcementEventTypes: Partial<
  Record<AnnouncementPeriodKind, readonly EventType[]>
> = {
  EVENT: ["MAIN_EVENT"],
  CAMPAIGN: ["CAMPAIGN", "PRE_RELEASE_CAMPAIGN"],
  QUEST: ["QUEST_RELEASE", "MAIN_EVENT"],
};

export const announcementMatchTypes = [
  ...new Set(Object.values(announcementEventTypes).flat()),
];

export interface AnnouncementMatchEvent {
  id: string;
  type: EventType;
  names: readonly string[];
  startsAt: Date;
  projectedStartsAt: Date;
  campaignComponentId?: string;
}

export function normaliseAnnouncementName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(\d+)\s*million\b/gu, "$1m")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const rerun = (value: string) => /\b(?:rerun|revival)\b/u.test(value);
const installment = (value: string) =>
  /^(?:\d+(?:st|nd|rd|th)?|[ivx]+)$/u.test(value);

function nameInContext(name: string, context: string) {
  const alias = normaliseAnnouncementName(name);
  const text = normaliseAnnouncementName(context);
  const tokens = alias.split(" ");
  if (
    tokens.length < RULES.minNameTokens ||
    alias.length < RULES.minNameCharacters ||
    rerun(alias) !== rerun(text)
  )
    return false;
  const words = text.split(" ");
  return words.some((_, start) => {
    if (!tokens.every((token, index) => words[start + index] === token))
      return false;
    // A base title cannot claim an explicitly numbered installment.
    const following = words[start + tokens.length] ?? "";
    return (
      !installment(following) &&
      !(
        /^(?:part|chapter|act|episode)$/u.test(following) &&
        installment(words[start + tokens.length + 1] ?? "")
      )
    );
  });
}

export function matchAnnouncementEvent(
  period: AnnouncementPeriod,
  articleName: string,
  events: readonly AnnouncementMatchEvent[],
) {
  const base = { revision: RULES.revision, publicationAllowed: false as const };
  const start = period.startsAt ? new Date(period.startsAt).getTime() : NaN;
  const end = period.endsAt ? new Date(period.endsAt).getTime() : NaN;
  const releaseOnly = period.kind === "QUEST" && period.endsAt === null;
  if (
    !announcementEventTypes[period.kind] ||
    period.issues.length ||
    !Number.isFinite(start) ||
    (!releaseOnly && (!Number.isFinite(end) || end < start)) ||
    !period.startTimezone ||
    (!releaseOnly && !period.endTimezone)
  )
    return {
      ...base,
      targetEventId: null,
      windowDays: null,
      candidateIds: [] as string[],
      reason: "UNSUPPORTED_EVENT_PERIOD" as const,
    };

  for (const windowDays of RULES.windowDays) {
    const matches = events.filter(
      (event) =>
        announcementEventTypes[period.kind]!.includes(event.type) &&
        [event.startsAt, event.projectedStartsAt].some(
          (date) =>
            Math.abs(date.getTime() - start) <=
            windowDays * MILLISECONDS_PER_DAY,
        ) &&
        event.names.some(
          (name) =>
            nameInContext(name, period.context) ||
            (period.articleNameAllowed !== false &&
              nameInContext(name, articleName)),
        ),
    );
    // A verified overall campaign owns its introductory period, not its exchange component.
    const overallMatches =
      period.kind === "CAMPAIGN" && period.articleNameAllowed !== false
        ? matches.filter(
            (event) =>
              !events.some(
                (parent) =>
                  parent.campaignComponentId === event.id &&
                  parent.names.some(
                    (name) =>
                      nameInContext(name, period.context) ||
                      nameInContext(name, articleName),
                  ),
              ),
          )
        : matches;
    const candidateIds = [
      ...new Set(overallMatches.map((event) => event.id)),
    ].sort();
    if (candidateIds.length)
      return {
        ...base,
        targetEventId: candidateIds.length === 1 ? candidateIds[0]! : null,
        windowDays,
        candidateIds,
        reason:
          candidateIds.length === 1
            ? ("UNIQUE_EVENT_MATCH" as const)
            : ("AMBIGUOUS_EVENT_MATCH" as const),
      };
  }
  return {
    ...base,
    targetEventId: null,
    windowDays: RULES.windowDays.at(-1)!,
    candidateIds: [] as string[],
    reason: "NO_EVENT_MATCH" as const,
  };
}

export function assessAnnouncementArticle(
  article: { name: string; periods: readonly AnnouncementPeriod[] },
  events: readonly AnnouncementMatchEvent[],
) {
  const matches = article.periods.map((period) =>
    matchAnnouncementEvent(period, article.name, events),
  );
  return matches.map((match, index) => {
    if (!match.targetEventId) return match;
    const period = article.periods[index]!;
    const conflicting = matches.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.targetEventId === match.targetEventId &&
        (article.periods[otherIndex]!.startsAt !== period.startsAt ||
          article.periods[otherIndex]!.endsAt !== period.endsAt),
    );
    return conflicting
      ? {
          ...match,
          targetEventId: null,
          reason: "CONFLICTING_EVENT_PERIODS" as const,
        }
      : match;
  });
}
