import { z } from "zod";

const safeCount = z.number().int().nonnegative().safe();

export const summonSpendInputSchema = z.object({
  multis: safeCount,
  quartzSingles: safeCount,
  tickets: safeCount,
  fragmentsConverted: safeCount.refine(
    (value) => value % 7 === 0,
    "Convert Saint Quartz Fragments in groups of seven.",
  ),
  startingBonusCount: z.number().int().min(0).max(9),
});

export type SummonSpendInput = z.infer<typeof summonSpendInputSchema>;

export type SummonCost = {
  quartzSpent: number;
  ticketsSpent: number;
  fragmentsConverted: number;
  quartzFromFragments: number;
  paidSummons: number;
  bonusSummons: number;
  totalResults: number;
  endingBonusCount: number;
};

export function automaticFragmentConversion({
  quartzCost,
  quartzAvailable,
  fragmentsAvailable,
}: {
  quartzCost: number;
  quartzAvailable: number;
  fragmentsAvailable: number;
}) {
  const cost = safeCount.parse(quartzCost);
  const availableQuartz = z.number().int().safe().parse(quartzAvailable);
  const availableFragments = Math.max(0, safeCount.parse(fragmentsAvailable));
  const missingQuartz = Math.max(0, cost - availableQuartz);
  const quartzFromFragments = Math.min(
    missingQuartz,
    Math.floor(availableFragments / 7),
  );
  return safeResult(quartzFromFragments * 7, "Fragment conversion");
}

export function parseSummonSpendInput(value: unknown): SummonSpendInput | null {
  const result = summonSpendInputSchema.safeParse(value);
  return result.success ? result.data : null;
}

function safeResult(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the supported range.`);
  }
  return value;
}

export function calculateSummonCost(value: SummonSpendInput): SummonCost {
  const input = summonSpendInputSchema.parse(value);
  const singleSummons = safeResult(
    input.quartzSingles + input.tickets,
    "Single summon count",
  );
  const bonusProgress = safeResult(
    input.startingBonusCount + singleSummons,
    "Bonus summon progress",
  );
  const multiPaidSummons = safeResult(input.multis * 10, "Multi summon count");
  const paidSummons = safeResult(
    multiPaidSummons + singleSummons,
    "Paid summon count",
  );
  const bonusSummons = safeResult(
    input.multis + Math.floor(bonusProgress / 10),
    "Bonus summon count",
  );

  return {
    quartzSpent: safeResult(
      input.multis * 30 + input.quartzSingles * 3,
      "Saint Quartz cost",
    ),
    ticketsSpent: input.tickets,
    fragmentsConverted: input.fragmentsConverted,
    quartzFromFragments: input.fragmentsConverted / 7,
    paidSummons,
    bonusSummons,
    totalResults: safeResult(paidSummons + bonusSummons, "Summon result count"),
    endingBonusCount: bonusProgress % 10,
  };
}
