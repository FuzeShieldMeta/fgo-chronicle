"use client";

import { useMemo, useState, type FormEvent } from "react";

import type { ForecastBalances } from "~/app/timeline/_lib/player-forecast";
import {
  automaticFragmentConversion,
  calculateSummonCost,
} from "~/app/timeline/_lib/summon-cost";
import {
  createSummonSession,
  updateSummonSession,
  type SummonSession,
} from "~/app/timeline/_lib/summon-session";

export type SummonPlanSpending = {
  multis: number;
  quartzSingles: number;
  tickets: number;
  fragmentsConverted: number;
  startingBonusCount: number;
  autoConvertFragments?: boolean;
};

export type SummonPlanTarget = {
  servantId: number | null;
  name: string;
  startingNp: number;
  rate: number;
  rateKind: "SOURCED" | "STANDARD_PRESET" | "CUSTOM";
  rateEvidenceUrl: string | null;
  guaranteedEligible: boolean;
  startingGuaranteedCount: number;
};

export type SummonPlanBanner = {
  id: string;
  name: string;
  lineupKey: string;
};

const multiPresets = [1, 3, 5, 10, 20, 30] as const;

export function SummonPlanPanel({
  day,
  banner,
  target,
  balances,
  spending,
  onSpendingChange,
  onSave,
  earliestAffordableDay,
  editingSession = null,
}: {
  day: string;
  banner: SummonPlanBanner | null;
  target: SummonPlanTarget | null;
  balances: ForecastBalances;
  spending: SummonPlanSpending;
  onSpendingChange: (spending: SummonPlanSpending) => void;
  onSave: (session: SummonSession) => void;
  earliestAffordableDay?: string | null;
  editingSession?: SummonSession | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const previewBalances = useMemo(() => {
    if (!editingSession) return balances;
    const originalCost = calculateSummonCost({
      ...editingSession.spending,
      startingBonusCount: editingSession.startingBonusCount,
    });
    return {
      ...balances,
      SAINT_QUARTZ:
        balances.SAINT_QUARTZ +
        originalCost.quartzSpent -
        originalCost.quartzFromFragments,
      SUMMON_TICKET: balances.SUMMON_TICKET + originalCost.ticketsSpent,
      SAINT_QUARTZ_FRAGMENT:
        balances.SAINT_QUARTZ_FRAGMENT + originalCost.fragmentsConverted,
    };
  }, [balances, editingSession]);
  const cost = useMemo(() => {
    try {
      const withoutFragments = calculateSummonCost({
        ...spending,
        fragmentsConverted: 0,
        startingBonusCount: 0,
      });
      const fragmentsConverted = spending.autoConvertFragments
        ? automaticFragmentConversion({
            quartzCost: withoutFragments.quartzSpent,
            quartzAvailable: previewBalances.SAINT_QUARTZ,
            fragmentsAvailable: previewBalances.SAINT_QUARTZ_FRAGMENT,
          })
        : 0;
      return calculateSummonCost({
        ...spending,
        fragmentsConverted,
        startingBonusCount: 0,
      });
    } catch {
      return null;
    }
  }, [previewBalances, spending]);

  const remaining = cost
    ? {
        quartz:
          previewBalances.SAINT_QUARTZ +
          cost.quartzFromFragments -
          cost.quartzSpent,
        tickets: previewBalances.SUMMON_TICKET - cost.ticketsSpent,
        fragments:
          previewBalances.SAINT_QUARTZ_FRAGMENT - cost.fragmentsConverted,
      }
    : null;
  const paidSingles = spending.quartzSingles + spending.tickets;
  const singleBonuses = Math.floor(paidSingles / 10);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!banner || !target) {
      setError("Select a summoning campaign and target Servant.");
      return;
    }

    try {
      const draft = {
        day,
        status: editingSession?.status ?? "PLANNED",
        banner,
        target: {
          servantId: target.servantId,
          name: target.name,
          startingNp: target.startingNp,
          rate: target.rate,
          rateKind: target.rateKind,
          rateEvidenceUrl: target.rateEvidenceUrl,
          guaranteedEligible: target.guaranteedEligible,
        },
        startingGuaranteedCount: target.startingGuaranteedCount,
        startingBonusCount: 0,
        spending: {
          multis: spending.multis,
          quartzSingles: spending.quartzSingles,
          tickets: spending.tickets,
          fragmentsConverted: cost?.fragmentsConverted ?? 0,
        },
        result: editingSession?.result ?? null,
      } satisfies Parameters<typeof createSummonSession>[0];
      const session = editingSession
        ? updateSummonSession([editingSession], editingSession.id, draft)[0]!
        : createSummonSession(draft);
      onSave(session);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Check the entered values.",
      );
    }
  }

  return (
    <form className="summon-plan-panel" onSubmit={submit}>
      <div className="summon-section-heading">
        <h4>Resource plan</h4>
        <p>Set the resources to use on this date.</p>
      </div>

      <fieldset className="summon-preset-fieldset">
        <legend>Quick add</legend>
        <div className="summon-preset-actions">
          <button
            type="button"
            onClick={() =>
              onSpendingChange({ ...spending, tickets: spending.tickets + 1 })
            }
          >
            +1 ticket
          </button>
          <button
            type="button"
            onClick={() =>
              onSpendingChange({
                ...spending,
                quartzSingles: spending.quartzSingles + 1,
              })
            }
          >
            +3 SQ single
          </button>
          <button
            type="button"
            onClick={() =>
              onSpendingChange({ ...spending, multis: spending.multis + 1 })
            }
          >
            +30 SQ multi
          </button>
        </div>
      </fieldset>

      <fieldset className="summon-preset-fieldset">
        <legend>Multi presets</legend>
        <div className="summon-preset-actions">
          {multiPresets.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={spending.multis === value}
              onClick={() => onSpendingChange({ ...spending, multis: value })}
            >
              {value}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="summon-field-grid summon-spend-fields">
        <label className="summon-field">
          <span>Multis</span>
          <input
            type="number"
            min="0"
            max="180"
            step="1"
            inputMode="numeric"
            value={spending.multis}
            onChange={(event) =>
              onSpendingChange({
                ...spending,
                multis: Math.max(0, Number(event.target.value)),
              })
            }
          />
          <small>11 results each</small>
        </label>
        <label className="summon-field">
          <span>Quartz singles</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={spending.quartzSingles}
            onChange={(event) =>
              onSpendingChange({
                ...spending,
                quartzSingles: Math.max(0, Number(event.target.value)),
              })
            }
          />
          <small>
            {paidSingles} singles + {singleBonuses} bonus
          </small>
        </label>
        <label className="summon-field">
          <span>Summon Tickets</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={spending.tickets}
            onChange={(event) =>
              onSpendingChange({
                ...spending,
                tickets: Math.max(0, Number(event.target.value)),
              })
            }
          />
          <small>Counts toward the single bonus</small>
        </label>
      </div>

      <label className="summon-checkbox-field">
        <input
          type="checkbox"
          checked={Boolean(spending.autoConvertFragments)}
          onChange={(event) =>
            onSpendingChange({
              ...spending,
              autoConvertFragments: event.target.checked,
            })
          }
        />
        Automatically convert SQ Fragments
      </label>

      {cost && remaining ? (
        <section className="summon-cost-summary" aria-live="polite">
          <h5>Plan summary</h5>
          <dl>
            <div>
              <dt>Cost</dt>
              <dd>
                {cost.quartzSpent.toLocaleString("en")} SQ ·{" "}
                {cost.ticketsSpent.toLocaleString("en")} tickets
              </dd>
            </div>
            <div>
              <dt>Results</dt>
              <dd>
                {cost.totalResults.toLocaleString("en")} total ·{" "}
                {cost.bonusSummons.toLocaleString("en")} bonus
              </dd>
            </div>
            {cost.fragmentsConverted > 0 ? (
              <div>
                <dt>Converted</dt>
                <dd>
                  {cost.fragmentsConverted.toLocaleString("en")} fragments →{" "}
                  {cost.quartzFromFragments.toLocaleString("en")} SQ
                </dd>
              </div>
            ) : null}
            <div data-shortfall={remaining.quartz < 0 ? "true" : undefined}>
              <dt>Quartz after</dt>
              <dd>{remaining.quartz.toLocaleString("en")}</dd>
            </div>
            <div data-shortfall={remaining.tickets < 0 ? "true" : undefined}>
              <dt>Tickets after</dt>
              <dd>{remaining.tickets.toLocaleString("en")}</dd>
            </div>
            <div data-shortfall={remaining.fragments < 0 ? "true" : undefined}>
              <dt>Fragments after</dt>
              <dd>{remaining.fragments.toLocaleString("en")}</dd>
            </div>
          </dl>
          {remaining.quartz < 0 ||
          remaining.tickets < 0 ||
          remaining.fragments < 0 ? (
            <div className="summon-affordability-note">
              <p className="timeline-form-error" role="alert">
                This plan has a resource shortfall. You can still save it.
              </p>
              {earliestAffordableDay === null ? (
                <p>It is not affordable within the current forecast.</p>
              ) : earliestAffordableDay && earliestAffordableDay !== day ? (
                <p>Earliest affordable date: {earliestAffordableDay}.</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <p className="timeline-form-error" role="alert">
          Check the summon and fragment counts.
        </p>
      )}

      {error ? (
        <p className="timeline-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="timeline-form-actions">
        <button type="submit">
          {editingSession ? "Update plan" : "Save plan"}
        </button>
      </div>
    </form>
  );
}
