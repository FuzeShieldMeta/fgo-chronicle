import { storyChapters, type StoryChapter } from "./story-progress";
import { calendarDayKey } from "~/app/timeline/_lib/schedule-layout";
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
  nature: "DETERMINISTIC" | "CONDITIONAL" | "CURATED_ESTIMATE";
  eligibility: string | null;
  storyWarId?: number | null;
  storyReleaseAt?: Date | null;
  defaultIncluded: boolean;
  reviewedAt: Date | null;
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
  hasUnresolvedConditional: boolean;
  contributions: ResolvedIncomeContribution[];
};

export type ResolvedIncomeContribution = IncomeContribution & {
  included: boolean;
  inclusionResolved: boolean;
  inclusionReason?: string;
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
) {
  const effectiveProfile =
    profile ?? createDefaultPlayerForecastProfile(days[0] ?? "1970-01-01");
  const daySet = new Set(days);
  const grouped = new Map<string, IncomeLedgerCell>();
  const contributions = [
    ...sourceContributions,
    ...loginMilestoneContributions(days, effectiveProfile),
    ...consecutiveLoginContributions(days, effectiveProfile),
    ...weeklyMasterMissionContributions(days, effectiveProfile),
    ...monthlyManaPrismTicketContributions(days, effectiveProfile),
  ];

  for (const unresolvedContribution of contributions) {
    const contribution = resolveContribution(
      unresolvedContribution,
      preferences,
      profile,
      catalogue,
    );
    const day = calendarDayKey(contribution.expectedAt, "EXACT", timeZone);
    if (!daySet.has(day)) continue;

    const key = cellKey(day, contribution.itemType);
    const existing = grouped.get(key);
    if (existing) {
      existing.contributions.push(contribution);
      if (contribution.included) existing.delta += contribution.amount;
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
      hasUnresolvedConditional: !contribution.inclusionResolved,
      contributions: [contribution],
    });
  }

  if (effectiveProfile) {
    for (const itemType of forecastResourceTypes) {
      let balance = effectiveProfile.snapshot.balances[itemType];

      for (const day of days) {
        if (day < effectiveProfile.snapshot.effectiveDate) continue;

        const cell = grouped.get(cellKey(day, itemType));
        if (day > effectiveProfile.snapshot.effectiveDate && cell) {
          balance += cell.delta;
        }
        if (cell) cell.closingBalance = balance;
      }
    }
  }

  return grouped;
}
