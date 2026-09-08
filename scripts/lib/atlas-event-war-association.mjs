import { ATLAS_PERMANENT_QUEST_WAR_IDS } from "./atlas-domain.mjs";

const DAY_SECONDS = 86_400;
const PERMANENT_RECORD_DAYS = 366;
const SHARED_WAR_DAYS = 366;

/** @param {Record<string, any>} war */
function spotQuests(war) {
  return (war.spots ?? []).flatMap(
    (/** @type {Record<string, any>} */ spot) => spot.quests ?? [],
  );
}

/** @param {Record<string, any>} event */
function isPermanentEvent(event) {
  return event.endedAt - event.startedAt > PERMANENT_RECORD_DAYS * DAY_SECONDS;
}

/** @param {Record<string, any>} war */
function isSharedWar(war) {
  const openings = spotQuests(war)
    .map((/** @type {Record<string, any>} */ quest) => quest.openedAt)
    .filter(Number.isInteger);
  if (openings.length < 2) return false;
  return (
    Math.max(...openings) - Math.min(...openings) >
    SHARED_WAR_DAYS * DAY_SECONDS
  );
}

/**
 * Keep only quests that belong to an event association.
 * @param {Record<string, any>} war
 * @param {Record<string, any>} event
 */
export function filterAtlasWarToEventWindow(
  war,
  event,
  { exactStartOnly = false, preserveFullAudit = false } = {},
) {
  const includesQuest = (/** @type {Record<string, any>} */ quest) =>
    Number.isInteger(quest.openedAt) &&
    (exactStartOnly
      ? quest.openedAt === event.startedAt
      : quest.openedAt >= event.startedAt && quest.openedAt <= event.endedAt);

  return {
    ...war,
    ...(preserveFullAudit ? { sourceWarAudit: war } : {}),
    spots: (war.spots ?? []).map((/** @type {Record<string, any>} */ spot) => ({
      ...spot,
      quests: (spot.quests ?? []).filter(includesQuest),
    })),
    questSelections: (war.questSelections ?? []).filter(
      (/** @type {Record<string, any>} */ selection) =>
        selection.quest && includesQuest(selection.quest),
    ),
  };
}

/** @param {{event: Record<string, any>, exactOpeningQuests: number}} left @param {{event: Record<string, any>, exactOpeningQuests: number}} right */
function compareProposals(left, right) {
  const finiteDifference =
    Number(isPermanentEvent(left.event)) -
    Number(isPermanentEvent(right.event));
  if (finiteDifference !== 0) return finiteDifference;
  if (left.exactOpeningQuests !== right.exactOpeningQuests) {
    return right.exactOpeningQuests - left.exactOpeningQuests;
  }
  const leftDuration = left.event.endedAt - left.event.startedAt;
  const rightDuration = right.event.endedAt - right.event.startedAt;
  return leftDuration - rightDuration;
}

/** @param {{event: Record<string, any>, exactOpeningQuests: number}} left @param {{event: Record<string, any>, exactOpeningQuests: number}} right */
function equallyPreferred(left, right) {
  return compareProposals(left, right) === 0;
}

/** @param {string | null | undefined} value */
function releaseIdentity(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** @param {Record<string, any>} wrapper @param {Record<string, any>} release */
function describesSameRelease(wrapper, release) {
  const wrapperNames = [wrapper.name, wrapper.originalName]
    .map(releaseIdentity)
    .filter(Boolean);
  const releaseNames = [release.name, release.originalName]
    .map(releaseIdentity)
    .filter(Boolean);
  return wrapperNames.some((wrapperName) =>
    releaseNames.some(
      (releaseName) =>
        releaseName === wrapperName ||
        releaseName.startsWith(`${wrapperName} `),
    ),
  );
}

/**
 * Infer missing event-to-war links only from an unambiguous exact opening-time
 * match. A war may serve several releases on different dates, but only one
 * event may claim the same war opening on the same date.
 * @param {Array<Record<string, any>>} events
 * @param {Array<Record<string, any>>} wars
 * @param {(event: any) => string | null} classifyEvent
 */
export function inferAtlasEventWarAssociations(events, wars, classifyEvent) {
  const unlinkedWars = wars.filter(
    (war) => !war.eventId && !ATLAS_PERMANENT_QUEST_WAR_IDS.has(war.id),
  );
  const proposals = [];
  const unresolvedEventIds = new Set();
  const ambiguousEventIds = new Set();
  const shadowedEventIds = new Set();

  for (const event of events) {
    const eventType = classifyEvent(event);
    if (
      !eventType ||
      !new Set(["MAIN_EVENT", "QUEST_RELEASE"]).has(eventType)
    ) {
      continue;
    }
    if (
      (event.warIds ?? []).length > 0 ||
      wars.some((war) => war.eventId === event.id)
    ) {
      continue;
    }

    const candidates = unlinkedWars
      .map((war) => ({
        war,
        exactOpeningQuests: spotQuests(war).filter(
          (/** @type {Record<string, any>} */ quest) =>
            quest.openedAt === event.startedAt,
        ).length,
      }))
      .filter(({ exactOpeningQuests }) => exactOpeningQuests > 0)
      .sort(
        (left, right) => right.exactOpeningQuests - left.exactOpeningQuests,
      );

    if (!candidates[0]) {
      unresolvedEventIds.add(event.id);
      continue;
    }
    if (
      candidates[1] &&
      candidates[1].exactOpeningQuests === candidates[0].exactOpeningQuests
    ) {
      ambiguousEventIds.add(event.id);
      continue;
    }
    proposals.push({ event, ...candidates[0] });
  }

  const proposalGroups = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.war.id}:${proposal.event.startedAt}`;
    const group = proposalGroups.get(key) ?? [];
    group.push(proposal);
    proposalGroups.set(key, group);
  }

  const associations = new Map();
  for (const group of proposalGroups.values()) {
    group.sort(compareProposals);
    const winner = group[0];
    if (!winner) continue;
    if (group[1] && equallyPreferred(winner, group[1])) {
      for (const proposal of group) ambiguousEventIds.add(proposal.event.id);
      continue;
    }
    associations.set(winner.event.id, {
      war: filterAtlasWarToEventWindow(winner.war, winner.event, {
        exactStartOnly:
          isPermanentEvent(winner.event) || isSharedWar(winner.war),
      }),
      exactOpeningQuests: winner.exactOpeningQuests,
    });
    for (const proposal of group.slice(1)) {
      if (
        isPermanentEvent(proposal.event) &&
        !isPermanentEvent(winner.event) &&
        describesSameRelease(proposal.event, winner.event)
      ) {
        shadowedEventIds.add(proposal.event.id);
      } else {
        unresolvedEventIds.add(proposal.event.id);
      }
    }
  }

  return {
    associations,
    unresolvedEventIds,
    ambiguousEventIds,
    shadowedEventIds,
  };
}
