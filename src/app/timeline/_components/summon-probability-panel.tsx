"use client";

import { useDeferredValue, useMemo, useState } from "react";

import {
  calculateSummonProbabilities,
  findMinimumSummonPlan,
  formatSummonProbability,
  npTargets,
  summonResultsForPlan,
  type NpTarget,
} from "~/app/timeline/_lib/summon-probability";

const multiPresets = [1, 3, 5, 10, 20, 30] as const;
const probabilityPresets = [50, 80, 90, 95, 99] as const;

export type SummonProbabilitySettings = {
  startingNp: number;
  currentGuaranteedCount: number;
  rate: number;
  guaranteedEligible: boolean;
};

export function SummonProbabilityPanel({
  settings,
  onUsePlan,
}: {
  settings: SummonProbabilitySettings;
  onUsePlan: (plan: { multis: number; singles: number }) => void;
}) {
  const [mode, setMode] = useState<"FORWARD" | "INVERSE">("FORWARD");
  const [customMultis, setCustomMultis] = useState(12);
  const [customSingles, setCustomSingles] = useState(0);
  const [desiredNp, setDesiredNp] = useState<NpTarget>(1);
  const [desiredPercent, setDesiredPercent] = useState(90);
  const deferredSettings = useDeferredValue(settings);
  const deferredCustomMultis = useDeferredValue(customMultis);
  const deferredCustomSingles = useDeferredValue(customSingles);
  const deferredDesiredNp = useDeferredValue(desiredNp);
  const deferredDesiredPercent = useDeferredValue(desiredPercent);
  const guaranteedAfter = deferredSettings.guaranteedEligible ? 330 : null;
  const startingGuaranteedCount = deferredSettings.guaranteedEligible
    ? deferredSettings.currentGuaranteedCount
    : 0;

  const rows = useMemo(() => {
    const plans = [
      ...multiPresets.map((multis) => ({ multis, singles: 0 })),
      { multis: deferredCustomMultis, singles: deferredCustomSingles },
    ].filter(
      (plan, index, values) =>
        Number.isSafeInteger(plan.multis) &&
        plan.multis >= 0 &&
        Number.isSafeInteger(plan.singles) &&
        plan.singles >= 0 &&
        values.findIndex(
          (candidate) =>
            candidate.multis === plan.multis &&
            candidate.singles === plan.singles,
        ) === index,
    );
    return plans.map((plan) => ({
      ...plan,
      summonResults: summonResultsForPlan(plan),
      result: calculateSummonProbabilities({
        rate: deferredSettings.rate,
        summonResults: summonResultsForPlan(plan),
        startingCopies: deferredSettings.startingNp,
        startingGuaranteedCount,
        guaranteedAfter,
      }),
    }));
  }, [
    deferredCustomMultis,
    deferredCustomSingles,
    deferredSettings.rate,
    deferredSettings.startingNp,
    guaranteedAfter,
    startingGuaranteedCount,
  ]);

  const inverse = useMemo(() => {
    if (mode !== "INVERSE") return null;
    return findMinimumSummonPlan({
      rate: deferredSettings.rate,
      target: deferredDesiredNp,
      desiredProbability: deferredDesiredPercent / 100,
      startingCopies: deferredSettings.startingNp,
      startingGuaranteedCount,
      guaranteedAfter,
      maximumPaidSummons: 1_800,
    });
  }, [
    deferredDesiredNp,
    deferredDesiredPercent,
    deferredSettings.rate,
    deferredSettings.startingNp,
    guaranteedAfter,
    mode,
    startingGuaranteedCount,
  ]);

  return (
    <section
      className="summon-probability-panel"
      aria-labelledby="probability-heading"
    >
      <div className="summon-section-heading">
        <h3 id="probability-heading">Summon probability</h3>
        <p>Probabilities show the chance of reaching at least each NP level.</p>
      </div>

      <div
        className="summon-mode-switch"
        role="group"
        aria-label="Probability lookup direction"
      >
        <button
          type="button"
          aria-pressed={mode === "FORWARD"}
          onClick={() => setMode("FORWARD")}
        >
          Summons to probability
        </button>
        <button
          type="button"
          aria-pressed={mode === "INVERSE"}
          onClick={() => setMode("INVERSE")}
        >
          Probability to summons
        </button>
      </div>

      {mode === "FORWARD" ? (
        <>
          <div className="summon-field-grid">
            <label className="summon-field">
              Multis
              <input
                type="number"
                min="0"
                max="180"
                step="1"
                inputMode="numeric"
                value={customMultis}
                onChange={(event) =>
                  setCustomMultis(
                    Math.min(
                      180,
                      Math.max(0, Math.floor(Number(event.target.value))),
                    ),
                  )
                }
              />
            </label>
            <label className="summon-field">
              Single summons
              <input
                type="number"
                min="0"
                max="1800"
                step="1"
                inputMode="numeric"
                value={customSingles}
                onChange={(event) =>
                  setCustomSingles(
                    Math.min(
                      1_800,
                      Math.max(0, Math.floor(Number(event.target.value))),
                    ),
                  )
                }
              />
            </label>
          </div>
          <div className="summon-probability-table-wrap">
            <table className="summon-probability-table">
              <caption>
                Chance of reaching NP1 through NP6 by summon plan
              </caption>
              <thead>
                <tr>
                  <th scope="col">Multis</th>
                  <th scope="col">Singles</th>
                  <th scope="col">SQ</th>
                  <th scope="col">Summons</th>
                  {npTargets.map((target) => (
                    <th key={target} scope="col">
                      NP{target}
                    </th>
                  ))}
                  <th scope="col">Plan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ multis, singles, summonResults, result }) => (
                  <tr
                    key={`${multis}:${singles}`}
                    data-custom={
                      multis === deferredCustomMultis &&
                      singles === deferredCustomSingles
                        ? "true"
                        : undefined
                    }
                  >
                    <th scope="row">{multis}</th>
                    <td>{singles}</td>
                    <td>{multis * 30 + singles * 3}</td>
                    <td>{summonResults}</td>
                    {npTargets.map((target) => (
                      <td key={target}>
                        {formatSummonProbability(result.atLeast[`NP${target}`])}
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        onClick={() => onUsePlan({ multis, singles })}
                      >
                        Use
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="summon-helper-text">
            NP6 means the sixth obtained copy. Noble Phantasm level remains
            capped at NP5.
          </p>
        </>
      ) : (
        <div className="summon-inverse-form">
          <label className="summon-field">
            Desired NP level
            <select
              value={desiredNp}
              onChange={(event) =>
                setDesiredNp(Number(event.target.value) as NpTarget)
              }
            >
              {npTargets.map((target) => (
                <option key={target} value={target}>
                  NP{target}
                  {target === 6 ? " · sixth copy" : ""}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="summon-preset-fieldset">
            <legend>Desired probability</legend>
            <div className="summon-preset-actions">
              {probabilityPresets.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={desiredPercent === value}
                  onClick={() => setDesiredPercent(value)}
                >
                  {value}%
                </button>
              ))}
            </div>
          </fieldset>
          <label className="summon-field">
            Custom probability
            <span className="summon-input-suffix">
              <input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={desiredPercent}
                onChange={(event) =>
                  setDesiredPercent(
                    Math.min(100, Math.max(0.01, Number(event.target.value))),
                  )
                }
              />
              <span aria-hidden="true">%</span>
            </span>
          </label>

          {inverse ? (
            <div className="summon-result-summary" role="status">
              <strong>
                {inverse.multis} multis + {inverse.singles} singles ·{" "}
                {inverse.summonResults} summons
              </strong>
              <span>
                {inverse.paidSummons} paid · {inverse.paidSummons * 3} SQ ·{" "}
                {formatSummonProbability(inverse.probability)} chance
              </span>
              <small>
                One fewer paid summon gives{" "}
                {formatSummonProbability(inverse.previousProbability)}.
              </small>
              <button
                type="button"
                onClick={() =>
                  onUsePlan({
                    multis: inverse.multis,
                    singles: inverse.singles,
                  })
                }
              >
                Use this plan
              </button>
            </div>
          ) : (
            <p className="timeline-form-error" role="alert">
              No result was found within 1,800 paid summons.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
