import type { IncomeLedgerCell } from "./income-ledger";
import type { RewardPreferences } from "./reward-preferences";
import type { SummonSession } from "./summon-session";
import { calendarDayKey } from "./schedule-layout";
import type { RewardChoiceDetails } from "../_components/use-reward-choice-details";

export type PersonalChangeMarker = { reward: boolean; summon: boolean };

export function buildPlannerChangeMarkers({
  ledgerCells,
  preferences,
  sessions,
  timeZone,
  rewardDetails = [],
}: {
  ledgerCells: ReadonlyMap<string, IncomeLedgerCell>;
  preferences: RewardPreferences;
  sessions: readonly SummonSession[];
  timeZone: string;
  rewardDetails?: readonly RewardChoiceDetails[];
}) {
  const days = new Map<string, PersonalChangeMarker>();
  const entries = new Map<string, PersonalChangeMarker>();
  const cells = new Map<string, PersonalChangeMarker>();
  function mark(
    map: Map<string, PersonalChangeMarker>,
    key: string,
    kind: keyof PersonalChangeMarker,
  ) {
    const marker = map.get(key) ?? { reward: false, summon: false };
    marker[kind] = true;
    map.set(key, marker);
  }
  const resolvedIds = new Set<string>();
  for (const cell of ledgerCells.values()) {
    for (const reward of cell.contributions) {
      if (!Object.hasOwn(preferences.includedByRewardId, reward.id)) continue;
      resolvedIds.add(reward.id);
      mark(days, cell.day, "reward");
      mark(cells, cell.key, "reward");
      if (reward.rewardSource.event)
        mark(entries, `event:${reward.rewardSource.event.id}`, "reward");
    }
  }
  for (const session of sessions) {
    mark(days, session.day, "summon");
    const spending = session.spending;
    if (
      spending.multis ||
      spending.quartzSingles ||
      spending.fragmentsConverted
    )
      mark(cells, `${session.day}:SAINT_QUARTZ`, "summon");
    if (spending.tickets) mark(cells, `${session.day}:SUMMON_TICKET`, "summon");
    if (spending.fragmentsConverted)
      mark(cells, `${session.day}:SAINT_QUARTZ_FRAGMENT`, "summon");
    if (session.banner.id)
      mark(entries, `banner:${session.banner.id}`, "summon");
  }
  for (const reward of rewardDetails) {
    if (!Object.hasOwn(preferences.includedByRewardId, reward.id)) continue;
    if (resolvedIds.has(reward.id)) continue;
    if (reward.event) mark(entries, reward.event.key, "reward");
    if (reward.expectedAt) {
      const day = calendarDayKey(
        reward.expectedAt,
        reward.expectedAtPrecision,
        timeZone,
      );
      mark(days, day, "reward");
      mark(cells, `${day}:${reward.itemType}`, "reward");
    }
  }
  return { days, entries, cells };
}
