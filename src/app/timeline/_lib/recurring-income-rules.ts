export const recurringIncomeRuleSet = {
  version: 1,
  region: "NA",
  verifiedAt: "2026-09-04T00:00:00.000Z",
  rules: {
    totalLogin: {
      firstRewardDay: 100,
      intervalDays: 50,
      saintQuartz: 30,
      evidenceUrl: "https://fategrandorder.fandom.com/wiki/Login_Rewards",
    },
    consecutiveLogin: {
      cycleLengthDays: 7,
      rewards: [
        { day: 2, itemType: "SAINT_QUARTZ", amount: 1 },
        { day: 4, itemType: "SAINT_QUARTZ", amount: 1 },
        { day: 6, itemType: "SAINT_QUARTZ", amount: 2 },
        { day: 7, itemType: "SUMMON_TICKET", amount: 1 },
      ],
      evidenceUrl: "https://fategrandorder.fandom.com/wiki/Login_Rewards",
    },
    weeklyMasterMissions: {
      fragmentAmount: 21,
      forecastWeekdayUtc: 0,
      evidenceUrl: "https://fategrandorder.fandom.com/wiki/Master_Missions",
    },
    monthlyManaPrismExchange: {
      maximumTickets: 5,
      manaPrismCostEach: 20,
      renewalDayOfMonth: 1,
      evidenceUrl: "https://fategrandorder.fandom.com/wiki/Mana_Prism_Exchange",
    },
  },
} as const;

export const recurringIncomeRules = recurringIncomeRuleSet.rules;
