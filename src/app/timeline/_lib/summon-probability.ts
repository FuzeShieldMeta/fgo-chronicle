export const npTargets = [1, 2, 3, 4, 5, 6] as const;

export type NpTarget = (typeof npTargets)[number];
export type NpProbabilityKey = `NP${NpTarget}`;

export type SummonProbabilityInput = {
  rate: number;
  summonResults: number;
  startingCopies: number;
  startingGuaranteedCount: number;
  guaranteedAfter: number | null;
};

export type SummonProbabilityResult = {
  exact: readonly number[];
  atLeast: Record<NpProbabilityKey, number>;
};

export type InverseSummonProbabilityInput = Omit<
  SummonProbabilityInput,
  "summonResults"
> & {
  target: NpTarget;
  desiredProbability: number;
  maximumPaidSummons: number;
};

export type InverseSummonProbabilityResult = {
  paidSummons: number;
  multis: number;
  singles: number;
  summonResults: number;
  probability: number;
  previousProbability: number;
};

const maximumDisplayedCopies = 6;

export type SummonPlanCount = {
  multis: number;
  singles: number;
};

export function summonResultsForPlan({ multis, singles }: SummonPlanCount) {
  if (
    !Number.isSafeInteger(multis) ||
    multis < 0 ||
    !Number.isSafeInteger(singles) ||
    singles < 0
  ) {
    throw new RangeError(
      "Multi and single counts must be non-negative integers.",
    );
  }

  const summonResults = multis * 11 + singles + Math.floor(singles / 10);
  if (!Number.isSafeInteger(summonResults)) {
    throw new RangeError("The summon result count is too large.");
  }
  return summonResults;
}

function validateInput(input: SummonProbabilityInput) {
  if (!Number.isFinite(input.rate) || input.rate <= 0 || input.rate > 1) {
    throw new RangeError(
      "The target rate must be greater than 0 and at most 1.",
    );
  }
  if (!Number.isSafeInteger(input.summonResults) || input.summonResults < 0) {
    throw new RangeError(
      "The summon result count must be a non-negative integer.",
    );
  }
  if (
    !Number.isInteger(input.startingCopies) ||
    input.startingCopies < 0 ||
    input.startingCopies > 5
  ) {
    throw new RangeError("The current NP level must be from NP0 through NP5.");
  }
  if (
    !Number.isInteger(input.startingGuaranteedCount) ||
    input.startingGuaranteedCount < 0
  ) {
    throw new RangeError(
      "The current Guaranteed Summon count must be a non-negative integer.",
    );
  }
  if (input.guaranteedAfter !== null) {
    if (
      !Number.isSafeInteger(input.guaranteedAfter) ||
      input.guaranteedAfter < 1
    ) {
      throw new RangeError(
        "The Guaranteed Summon interval must be a positive integer.",
      );
    }
    if (input.startingGuaranteedCount >= input.guaranteedAfter) {
      throw new RangeError(
        "The current Guaranteed Summon count must be below its interval.",
      );
    }
  } else if (input.startingGuaranteedCount !== 0) {
    throw new RangeError(
      "A Guaranteed Summon count requires a Guaranteed Summon interval.",
    );
  }
}

function stateIndex(copyCount: number, missCount: number, missStates: number) {
  return copyCount * missStates + missCount;
}

function initialState(input: SummonProbabilityInput) {
  const missStates = input.guaranteedAfter ?? 1;
  const state = new Float64Array((maximumDisplayedCopies + 1) * missStates);
  state[
    stateIndex(input.startingCopies, input.startingGuaranteedCount, missStates)
  ] = 1;
  return state;
}

function advanceState(current: Float64Array, input: SummonProbabilityInput) {
  const missStates = input.guaranteedAfter ?? 1;
  const next = new Float64Array(current.length);

  for (let copyCount = 0; copyCount <= maximumDisplayedCopies; copyCount += 1) {
    for (let missCount = 0; missCount < missStates; missCount += 1) {
      const probability = current[stateIndex(copyCount, missCount, missStates)];
      if (!probability) continue;

      const isGuaranteed =
        input.guaranteedAfter !== null &&
        missCount === input.guaranteedAfter - 1;
      const successRate = isGuaranteed ? 1 : input.rate;
      const successCopies = Math.min(maximumDisplayedCopies, copyCount + 1);
      next[stateIndex(successCopies, 0, missStates)]! +=
        probability * successRate;

      if (successRate < 1) {
        const nextMissCount =
          input.guaranteedAfter === null ? 0 : missCount + 1;
        next[stateIndex(copyCount, nextMissCount, missStates)]! +=
          probability * (1 - successRate);
      }
    }
  }

  return next;
}

function resultFromState(
  current: Float64Array,
  guaranteedAfter: number | null,
): SummonProbabilityResult {
  const missStates = guaranteedAfter ?? 1;
  const exact = Array.from({ length: maximumDisplayedCopies + 1 }, () => 0);
  for (let copyCount = 0; copyCount <= maximumDisplayedCopies; copyCount += 1) {
    for (let missCount = 0; missCount < missStates; missCount += 1) {
      exact[copyCount]! +=
        current[stateIndex(copyCount, missCount, missStates)] ?? 0;
    }
  }

  const atLeast = Object.fromEntries(
    npTargets.map((target) => [
      `NP${target}`,
      exact
        .slice(target)
        .reduce((total, probability) => total + probability, 0),
    ]),
  ) as Record<NpProbabilityKey, number>;

  return { exact, atLeast };
}

export function calculateSummonProbabilities(
  input: SummonProbabilityInput,
): SummonProbabilityResult {
  validateInput(input);

  let current = initialState(input);

  for (let summon = 0; summon < input.summonResults; summon += 1) {
    current = advanceState(current, input);
  }

  return resultFromState(current, input.guaranteedAfter);
}

export function findMinimumSummonPlan(
  input: InverseSummonProbabilityInput,
): InverseSummonProbabilityResult | null {
  const baseInput: SummonProbabilityInput = {
    rate: input.rate,
    summonResults: 0,
    startingCopies: input.startingCopies,
    startingGuaranteedCount: input.startingGuaranteedCount,
    guaranteedAfter: input.guaranteedAfter,
  };
  validateInput(baseInput);

  if (!npTargets.includes(input.target)) {
    throw new RangeError("The desired NP level must be from NP1 through NP6.");
  }
  if (
    !Number.isFinite(input.desiredProbability) ||
    input.desiredProbability <= 0 ||
    input.desiredProbability > 1
  ) {
    throw new RangeError(
      "The desired probability must be greater than 0 and at most 1.",
    );
  }
  if (
    !Number.isSafeInteger(input.maximumPaidSummons) ||
    input.maximumPaidSummons < 0
  ) {
    throw new RangeError(
      "The maximum paid summon count must be a non-negative integer.",
    );
  }

  let current = initialState(baseInput);
  const probabilityKey = `NP${input.target}` as const;
  let previousProbability = resultFromState(current, input.guaranteedAfter)
    .atLeast[probabilityKey];

  if (previousProbability >= input.desiredProbability) {
    return {
      paidSummons: 0,
      multis: 0,
      singles: 0,
      summonResults: 0,
      probability: previousProbability,
      previousProbability,
    };
  }

  for (
    let paidSummons = 1;
    paidSummons <= input.maximumPaidSummons;
    paidSummons += 1
  ) {
    current = advanceState(current, baseInput);
    if (paidSummons % 10 === 0) {
      current = advanceState(current, baseInput);
    }
    const probability = resultFromState(current, input.guaranteedAfter).atLeast[
      probabilityKey
    ];
    if (probability >= input.desiredProbability) {
      return {
        paidSummons,
        multis: Math.floor(paidSummons / 10),
        singles: paidSummons % 10,
        summonResults: paidSummons + Math.floor(paidSummons / 10),
        probability,
        previousProbability,
      };
    }
    previousProbability = probability;
  }

  return null;
}

export function formatSummonProbability(probability: number) {
  const floatingPointTolerance = 1e-12;
  if (
    !Number.isFinite(probability) ||
    probability < -floatingPointTolerance ||
    probability > 1 + floatingPointTolerance
  ) {
    throw new RangeError("The probability must be from 0 through 1.");
  }
  const normalizedProbability = Math.min(1, Math.max(0, probability));
  if (normalizedProbability > 0 && normalizedProbability < 0.0001) {
    return "<0.01%";
  }
  return `${(normalizedProbability * 100).toFixed(2)}%`;
}
