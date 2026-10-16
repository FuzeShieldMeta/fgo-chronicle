import { storyChapters, type StoryChapter } from "./story-progress";
import {
  calendarDayKey,
  calendarDays,
} from "~/app/timeline/_lib/schedule-layout";
import {
  createDefaultPlayerForecastProfile,
  forecastResourceTypes,
  type ForecastResourceType,
  type PlayerForecastProfile,
} from "~/app/timeline/_lib/player-forecast";
import {
  recurringIncomeRules,
  recurringIncomeRuleSet,
} from "~/app/timeline/_lib/recurring-income-rules";
import {
  createRewardPreferences,
  resolveRewardInclusion,
  type RewardPreferences,
} from "~/app/timeline/_lib/reward-preferences";
import {
  automaticFragmentConversion,
  calculateSummonCost,
  type SummonSpendInput,
} from "~/app/timeline/_lib/summon-cost";
import type { SummonSession } from "~/app/timeline/_lib/summon-session";

export const incomeResourceLabels: Record<ForecastResourceType, string> = {
  SAINT_QUARTZ: "Saint Quartz",
  SUMMON_TICKET: "Summon Tickets",
  SAINT_QUARTZ_FRAGMENT: "SQ Fragments",
  HOLY_GRAIL: "Holy Grails",
  CRYSTALLIZED_LORE: "Crystallised Lores",
};

export const incomeResourceIcons: Record<ForecastResourceType, string> = {
  SAINT_QUARTZ: "https://static.atlasacademy.io/NA/Items/6.png",
  SUMMON_TICKET: "https://static.atlasacademy.io/NA/Items/4001.png",
  SAINT_QUARTZ_FRAGMENT: "https://static.atlasacademy.io/NA/Items/16.png",
  HOLY_GRAIL: "https://static.atlasacademy.io/NA/Items/7999.png",
  CRYSTALLIZED_LORE: "https://static.atlasacademy.io/NA/Items/6999.png",
};

export type IncomeContribution = {
  id: string;
  itemType: ForecastResourceType;
  amount: number;
  expectedAt: Date;
  expectedAtPrecision?: "DATE_ONLY" | "EXACT";
  nature: "DETERMINISTIC" | "CONDITIONAL" | "CURATED_ESTIMATE";
  eligibility: string | null;
  storyWarId?: number | null;
  storyReleaseAt?: Date | null;
  defaultIncluded: boolean;
  reviewedAt: Date | null;
  reviewStatus?: "UNREVIEWED" | "REVIEWED" | "NEEDS_REVIEW";
  assumption?: string | null;
  rewardSource: {
    id: string;
    name: string;
    type: string;
    status: "PROJECTED" | "CURATED" | "OFFICIAL";
    evidenceUrl: string;
    event: { id: string; name: string } | null;
  };
};

export type IncomeLedgerCell = {
  key: string;
  day: string;
  itemType: ForecastResourceType;
  delta: number;
  closingBalance: number | null;
  incomeDelta: number;
  sessionDelta: number;
  hasUnresolvedConditional: boolean;
  contributions: ResolvedIncomeContribution[];
  sessionChanges: SummonSessionResourceChange[];
};

export type ResolvedIncomeContribution = IncomeContribution & {
  included: boolean;
  inclusionResolved: boolean;
  inclusionReason?: string;
};

export type SummonSessionResourceChange = {
  id: string;
  sessionId: string;
  day: string;
  itemType: ForecastResourceType;
  amount: number;
  kind: "FRAGMENT_CONVERSION" | "SUMMON_SPEND";
  status: SummonSession["status"];
  bannerName: string;
  targetName: string;
  createdAt: string;
};

const recurringRuleReviewedAt = new Date(recurringIncomeRuleSet.verifiedAt);

function cellKey(day: string, itemType: ForecastResourceType) {
  return `${day}:${itemType}`;
}

function resolveContribution(
  contribution: IncomeContribution,
  preferences: RewardPreferences,
  profile: PlayerForecastProfile | null,
  catalogue: StoryChapter[],
): ResolvedIncomeContribution {
  return {
    ...contribution,
    ...resolveRewardInclusion(contribution, preferences, profile, catalogue),
  };
}

function summonSessionResourceChanges(
  session: SummonSession,
): SummonSessionResourceChange[] {
  const cost = calculateSummonCost({
    ...session.spending,
    startingBonusCount: session.startingBonusCount,
  });
  const common = {
    sessionId: session.id,
    day: session.day,
    status: session.status,
    bannerName: session.banner.name,
    targetName: session.target.name,
    createdAt: session.createdAt,
  };
  const changes: SummonSessionResourceChange[] = [];

  if (cost.fragmentsConverted > 0) {
    changes.push(
      {
        ...common,
        id: `${session.id}:fragment-conversion:fragments`,
        itemType: "SAINT_QUARTZ_FRAGMENT",
        amount: -cost.fragmentsConverted,
        kind: "FRAGMENT_CONVERSION",
      },
      {
        ...common,
        id: `${session.id}:fragment-conversion:quartz`,
        itemType: "SAINT_QUARTZ",
        amount: cost.quartzFromFragments,
        kind: "FRAGMENT_CONVERSION",
      },
    );
  }
  if (cost.quartzSpent > 0) {
    changes.push({
      ...common,
      id: `${session.id}:summon-spend:quartz`,
      itemType: "SAINT_QUARTZ",
      amount: -cost.quartzSpent,
      kind: "SUMMON_SPEND",
    });
  }
  if (cost.ticketsSpent > 0) {
    changes.push({
      ...common,
      id: `${session.id}:summon-spend:tickets`,
      itemType: "SUMMON_TICKET",
      amount: -cost.ticketsSpent,
      kind: "SUMMON_SPEND",
    });
  }

  return changes;
}

function loginMilestoneContributions(
  days: string[],
  profile: PlayerForecastProfile | null,
): IncomeContribution[] {
  const currentCount = profile?.cumulativeLoginCount;
  const rule = recurringIncomeRules.totalLogin;
  const firstOffset =
    currentCount === null || currentCount === undefined
      ? rule.intervalDays
      : currentCount < 100
        ? rule.firstRewardDay - currentCount
        : rule.intervalDays - (currentCount % rule.intervalDays || 0);
  const contributions: IncomeContribution[] = [];

  for (
    let index = firstOffset;
    index < days.length;
    index += rule.intervalDays
  ) {
    const day = days[index];
    if (!day) continue;

    contributions.push({
      id: `recurring-v${recurringIncomeRuleSet.version}:login-milestone:${day}`,
      itemType: "SAINT_QUARTZ",
      amount: rule.saintQuartz,
      expectedAt: new Date(`${day}T04:00:00.000Z`),
      nature: "CONDITIONAL",
      eligibility: "Log in on each expected day before this milestone.",
      defaultIncluded: true,
      reviewedAt: recurringRuleReviewedAt,
      rewardSource: {
        id: "estimated-login-milestone",
        name: "Total login milestone",
        type: "LOGIN_MILESTONE",
        status: "PROJECTED",
        evidenceUrl: rule.evidenceUrl,
        event: null,
      },
    });
  }

  return contributions;
}

function consecutiveLoginContributions(
  days: string[],
  profile: PlayerForecastProfile,
): IncomeContribution[] {
  const rule = recurringIncomeRules.consecutiveLogin;
  const currentCycleDay =
    profile.consecutiveLoginDay ?? profile.cumulativeLoginCount;
  const assumption =
    profile.consecutiveLoginDay === null
      ? "The consecutive login day is estimated from the total login count. A missed login can make this date inaccurate."
      : null;

  return days.slice(1).flatMap((day, relativeIndex) => {
    const offset = relativeIndex + 1;
    const cycleDay =
      ((currentCycleDay + offset - 1) % rule.cycleLengthDays) + 1;

    return rule.rewards
      .filter((reward) => reward.day === cycleDay)
      .map((reward) => ({
        id: `recurring-v${recurringIncomeRuleSet.version}:consecutive-login:${day}:${reward.itemType}`,
        itemType: reward.itemType,
        amount: reward.amount,
        expectedAt: new Date(`${day}T04:00:00.000Z`),
        nature: "CONDITIONAL" as const,
        eligibility: `Log in on consecutive login day ${cycleDay}.`,
        defaultIncluded: true,
        reviewedAt: recurringRuleReviewedAt,
        assumption,
        rewardSource: {
          id: "consecutive-login-cycle",
          name: "Consecutive login reward",
          type: "LOGIN_BONUS",
          status: "CURATED" as const,
          evidenceUrl: rule.evidenceUrl,
          event: null,
        },
      }));
  });
}

function weeklyMasterMissionContributions(
  days: string[],
  profile: PlayerForecastProfile,
): IncomeContribution[] {
  if (!profile.includeWeeklyMasterMissions) return [];
  const rule = recurringIncomeRules.weeklyMasterMissions;

  return days.slice(1).flatMap((day) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    if (date.getUTCDay() !== rule.forecastWeekdayUtc) return [];

    return [
      {
        id: `recurring-v${recurringIncomeRuleSet.version}:weekly-master-missions:${day}`,
        itemType: "SAINT_QUARTZ_FRAGMENT" as const,
        amount: rule.fragmentAmount,
        expectedAt: new Date(`${day}T23:59:59.000Z`),
        nature: "CONDITIONAL" as const,
        eligibility: "Complete all seven weekly Master Missions.",
        defaultIncluded: true,
        reviewedAt: recurringRuleReviewedAt,
        assumption:
          "All weekly Master Missions are included by the forecast setting.",
        rewardSource: {
          id: "weekly-master-missions",
          name: "Weekly Master Missions",
          type: "MASTER_MISSION",
          status: "CURATED" as const,
          evidenceUrl: rule.evidenceUrl,
          event: null,
        },
      },
    ];
  });
}

function monthlyManaPrismTicketContributions(
  days: string[],
  profile: PlayerForecastProfile,
): IncomeContribution[] {
  if (!profile.includeMonthlyManaPrismTickets) return [];
  const rule = recurringIncomeRules.monthlyManaPrismExchange;
  const ticketCount = rule.maximumTickets;
  const totalCost = ticketCount * rule.manaPrismCostEach;

  return days.slice(1).flatMap((day) => {
    const dayOfMonth = Number(day.slice(-2));
    if (dayOfMonth !== rule.renewalDayOfMonth) return [];

    return [
      {
        id: `recurring-v${recurringIncomeRuleSet.version}:monthly-mana-prism-tickets:${day}`,
        itemType: "SUMMON_TICKET" as const,
        amount: ticketCount,
        expectedAt: new Date(`${day}T00:00:00.000Z`),
        nature: "CONDITIONAL" as const,
        eligibility: `Exchange ${totalCost} Mana Prisms for all ${ticketCount} Summon Tickets.`,
        defaultIncluded: true,
        reviewedAt: recurringRuleReviewedAt,
        assumption: `The forecast assumes you buy all ${ticketCount} monthly tickets when the shop renews.`,
        rewardSource: {
          id: "monthly-mana-prism-exchange",
          name: "Monthly Mana Prism exchange",
          type: "MANA_PRISM_EXCHANGE",
          status: "CURATED" as const,
          evidenceUrl: rule.evidenceUrl,
          event: null,
        },
      },
    ];
  });
}

export function buildIncomeLedger(
  days: string[],
  sourceContributions: IncomeContribution[],
  profile: PlayerForecastProfile | null,
  timeZone: string,
  preferences: RewardPreferences = createRewardPreferences(),
  catalogue: StoryChapter[] = storyChapters,
  summonSessions: SummonSession[] = [],
) {
  if (!days.length) return new Map<string, IncomeLedgerCell>();
  const effectiveProfile =
    profile ?? createDefaultPlayerForecastProfile(days[0] ?? "1970-01-01");
  const visibleDays = new Set(days);
  // Calculate from the snapshot, not from the left edge of the visible window.
  // This also keeps login milestones and cycles anchored across day rollover.
  const calculationDays = calendarDays(
    effectiveProfile.snapshot.effectiveDate < days[0]!
      ? effectiveProfile.snapshot.effectiveDate
      : days[0]!,
    days.at(-1)!,
  );
  const daySet = new Set(calculationDays);
  const recurringDays =
    effectiveProfile.snapshot.effectiveDate <= days.at(-1)!
      ? calendarDays(effectiveProfile.snapshot.effectiveDate, days.at(-1)!)
      : [];
  const grouped = new Map<string, IncomeLedgerCell>();
  const contributions = [
    ...sourceContributions,
    ...loginMilestoneContributions(recurringDays, effectiveProfile),
    ...consecutiveLoginContributions(recurringDays, effectiveProfile),
    ...weeklyMasterMissionContributions(recurringDays, effectiveProfile),
    ...monthlyManaPrismTicketContributions(recurringDays, effectiveProfile),
  ];

  for (const unresolvedContribution of contributions) {
    const contribution = resolveContribution(
      unresolvedContribution,
      preferences,
      profile,
      catalogue,
    );
    const day = calendarDayKey(
      contribution.expectedAt,
      contribution.expectedAtPrecision ?? "EXACT",
      timeZone,
    );
    if (!daySet.has(day)) continue;

    const key = cellKey(day, contribution.itemType);
    const existing = grouped.get(key);
    if (existing) {
      existing.contributions.push(contribution);
      if (contribution.included) {
        existing.incomeDelta += contribution.amount;
        existing.delta += contribution.amount;
      }
      if (!contribution.inclusionResolved) {
        existing.hasUnresolvedConditional = true;
      }
      continue;
    }

    grouped.set(key, {
      key,
      day,
      itemType: contribution.itemType,
      delta: contribution.included ? contribution.amount : 0,
      closingBalance: null,
      incomeDelta: contribution.included ? contribution.amount : 0,
      sessionDelta: 0,
      hasUnresolvedConditional: !contribution.inclusionResolved,
      contributions: [contribution],
      sessionChanges: [],
    });
  }

  const sessionChanges = [...summonSessions]
    .sort(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .flatMap(summonSessionResourceChanges);

  for (const change of sessionChanges) {
    if (!daySet.has(change.day)) continue;
    const key = cellKey(change.day, change.itemType);
    const existing = grouped.get(key);
    if (existing) {
      existing.sessionChanges.push(change);
      existing.sessionDelta += change.amount;
      existing.delta += change.amount;
      continue;
    }

    grouped.set(key, {
      key,
      day: change.day,
      itemType: change.itemType,
      delta: change.amount,
      closingBalance: null,
      incomeDelta: 0,
      sessionDelta: change.amount,
      hasUnresolvedConditional: false,
      contributions: [],
      sessionChanges: [change],
    });
  }

  if (effectiveProfile) {
    for (const itemType of forecastResourceTypes) {
      let balance = effectiveProfile.snapshot.balances[itemType];
      for (const day of calculationDays) {
        if (day < effectiveProfile.snapshot.effectiveDate) continue;

        let cell = grouped.get(cellKey(day, itemType));
        if (cell) {
          if (day > effectiveProfile.snapshot.effectiveDate) {
            balance += cell.delta;
          } else if (day === effectiveProfile.snapshot.effectiveDate) {
            balance += cell.sessionDelta;
          }
        }
        if (
          day === days[0] &&
          !cell &&
          balance !== effectiveProfile.snapshot.balances[itemType]
        ) {
          // Expose the carried opening balance without moving old deltas to today.
          cell = {
            key: cellKey(day, itemType),
            day,
            itemType,
            delta: 0,
            incomeDelta: 0,
            sessionDelta: 0,
            closingBalance: null,
            hasUnresolvedConditional: false,
            contributions: [],
            sessionChanges: [],
          };
          grouped.set(cell.key, cell);
        }
        if (cell) cell.closingBalance = balance;
      }
    }
  }

  return new Map([...grouped].filter(([, cell]) => visibleDays.has(cell.day)));
}

export function forecastBalancesOnDay(
  cells: Map<string, IncomeLedgerCell>,
  profile: PlayerForecastProfile | null,
  forecastStartDay: string,
  day: string,
) {
  const effectiveProfile =
    profile ?? createDefaultPlayerForecastProfile(forecastStartDay);
  const balances = { ...effectiveProfile.snapshot.balances };
  const latestDayByType = new Map<ForecastResourceType, string>();

  for (const cell of cells.values()) {
    if (
      cell.day > day ||
      cell.day < effectiveProfile.snapshot.effectiveDate ||
      cell.closingBalance === null
    ) {
      continue;
    }
    const latestDay = latestDayByType.get(cell.itemType);
    if (latestDay && latestDay > cell.day) continue;
    latestDayByType.set(cell.itemType, cell.day);
    balances[cell.itemType] = cell.closingBalance;
  }

  return balances;
}

export function findEarliestAffordableSummonDay(
  cells: Map<string, IncomeLedgerCell>,
  profile: PlayerForecastProfile | null,
  forecastStartDay: string,
  days: string[],
  startingDay: string,
  spending: SummonSpendInput & { autoConvertFragments?: boolean },
  excludedSession?: SummonSession,
) {
  for (const day of days) {
    if (day < startingDay) continue;
    const balances = forecastBalancesOnDay(
      cells,
      profile,
      forecastStartDay,
      day,
    );
    if (excludedSession && excludedSession.day <= day) {
      const excludedCost = calculateSummonCost({
        ...excludedSession.spending,
        startingBonusCount: excludedSession.startingBonusCount,
      });
      balances.SAINT_QUARTZ +=
        excludedCost.quartzSpent - excludedCost.quartzFromFragments;
      balances.SUMMON_TICKET += excludedCost.ticketsSpent;
      balances.SAINT_QUARTZ_FRAGMENT += excludedCost.fragmentsConverted;
    }
    const costWithoutFragments = calculateSummonCost({
      ...spending,
      fragmentsConverted: 0,
      startingBonusCount: 0,
    });
    const fragmentsConverted = spending.autoConvertFragments
      ? automaticFragmentConversion({
          quartzCost: costWithoutFragments.quartzSpent,
          quartzAvailable: balances.SAINT_QUARTZ,
          fragmentsAvailable: balances.SAINT_QUARTZ_FRAGMENT,
        })
      : spending.fragmentsConverted;
    const cost = calculateSummonCost({
      ...spending,
      fragmentsConverted,
      startingBonusCount: 0,
    });
    const hasFragments =
      balances.SAINT_QUARTZ_FRAGMENT >= cost.fragmentsConverted;
    const hasQuartz =
      balances.SAINT_QUARTZ + cost.quartzFromFragments >= cost.quartzSpent;
    const hasTickets = balances.SUMMON_TICKET >= cost.ticketsSpent;

    if (hasFragments && hasQuartz && hasTickets) return day;
  }

  return null;
}
