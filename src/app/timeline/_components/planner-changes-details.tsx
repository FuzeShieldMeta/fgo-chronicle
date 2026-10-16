"use client";

import { useState } from "react";
import type { RewardPreferences } from "../_lib/reward-preferences";
import type { SummonSession } from "../_lib/summon-session";
import { calculateSummonCost } from "../_lib/summon-cost";
import { incomeResourceLabels } from "../_lib/income-ledger";
import type { IncomeLedgerCell } from "../_lib/income-ledger";
import { englishRewardLabel } from "../_lib/reward-labels";
import { calendarDayKey } from "../_lib/schedule-layout";
import type { RewardChoiceDetails } from "./use-reward-choice-details";
import type { TimelineSearchEntry } from "~/shared/timeline-search";

export function PlannerChangesDetails({
  sessions,
  preferences,
  rewards,
  ledgerCells,
  entries = [],
  status,
  timeZone,
  fromDay,
  throughDay,
  onRetry,
  onOpenSession,
  onOpenReward,
  onResetReward,
  onClose,
}: {
  sessions: readonly SummonSession[];
  preferences: RewardPreferences;
  rewards: readonly RewardChoiceDetails[];
  ledgerCells: ReadonlyMap<string, IncomeLedgerCell>;
  entries?: readonly Pick<
    TimelineSearchEntry,
    "key" | "name" | "startsAt" | "startsAtPrecision"
  >[];
  status: "loading" | "ready" | "error";
  timeZone: string;
  fromDay: string;
  throughDay: string;
  onRetry: () => void;
  onOpenSession: (session: SummonSession) => Promise<void>;
  onOpenReward: (
    event: NonNullable<RewardChoiceDetails["event"]>,
  ) => Promise<void>;
  onResetReward: (id: string) => void;
  onClose: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  const metadata = new Map(rewards.map((reward) => [reward.id, reward]));
  const events = new Map(entries.map((entry) => [entry.key, entry]));
  // Keep loaded rewards readable even when the metadata request fails.
  for (const cell of ledgerCells.values()) {
    for (const reward of cell.contributions) {
      if (
        !Object.hasOwn(preferences.includedByRewardId, reward.id) ||
        metadata.has(reward.id)
      )
        continue;
      metadata.set(reward.id, {
        id: reward.id,
        name: reward.rewardSource.name,
        amount: reward.amount,
        itemType: reward.itemType,
        expectedAt: reward.expectedAt,
        expectedAtPrecision: reward.expectedAtPrecision ?? "EXACT",
        event: reward.rewardSource.event
          ? (events.get(`event:${reward.rewardSource.event.id}`) ?? null)
          : null,
      });
    }
  }
  const choices = Object.entries(preferences.includedByRewardId).sort(
    ([a], [b]) => {
      const first = metadata.get(a)?.expectedAt?.getTime() ?? Infinity;
      const second = metadata.get(b)?.expectedAt?.getTime() ?? Infinity;
      return first - second || a.localeCompare(b);
    },
  );
  async function open(action: () => Promise<void>) {
    if (opening) return;
    setOpening(true);
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    } finally {
      setOpening(false);
    }
  }
  return (
    <aside
      className="timeline-details"
      data-empty="false"
      aria-labelledby="timeline-changes-heading"
    >
      <div className="timeline-details-handle" aria-hidden="true" />
      <div className="timeline-details-header">
        <div>
          <span className="timeline-type-label">Planner</span>
          <h3 id="timeline-changes-heading">Changes</h3>
        </div>
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <p className="summon-helper-text">
        Your saved summon sessions and reward choices. Starting balances are
        under Balances.
      </p>
      <div className="timeline-change-key">
        <span data-change="reward">Reward choice</span>
        <span data-change="summon">Summon session</span>
      </div>
      {opening ? <p role="status">Opening the timeline…</p> : null}
      {error ? <p role="alert">This entry could not open. Try again.</p> : null}
      <section className="timeline-detail-section">
        <h4>Summons ({sessions.length})</h4>
        {sessions.length ? (
          <ul>
            {[...sessions]
              .sort(
                (a, b) =>
                  a.day.localeCompare(b.day) || a.id.localeCompare(b.id),
              )
              .map((session) => {
                const cost = calculateSummonCost({
                  ...session.spending,
                  startingBonusCount: session.startingBonusCount,
                });
                const outsideTimeline =
                  session.day < fromDay || session.day > throughDay;
                return (
                  <li
                    key={session.id}
                    className="timeline-change-row"
                    data-change="summon"
                  >
                    <button
                      type="button"
                      className="timeline-related-entry-button"
                      disabled={opening || outsideTimeline}
                      onClick={() => void open(() => onOpenSession(session))}
                    >
                      <strong>{session.target.name}</strong>
                      <span>{session.banner.name}</span>
                      <small>
                        {session.day} ·{" "}
                        {session.day < fromDay ? "Past plan" : "Planned"}
                      </small>
                      {outsideTimeline ? (
                        <small>Outside the current timeline</small>
                      ) : null}
                      <small>
                        {cost.quartzSpent.toLocaleString("en")} SQ ·{" "}
                        {cost.ticketsSpent.toLocaleString("en")} tickets
                        {cost.fragmentsConverted
                          ? ` · ${cost.fragmentsConverted.toLocaleString("en")} fragments converted`
                          : ""}
                      </small>
                    </button>
                  </li>
                );
              })}
          </ul>
        ) : (
          <p>No summon sessions saved.</p>
        )}
      </section>
      <section className="timeline-detail-section">
        <h4>Reward choices ({choices.length})</h4>
        {choices.length && status === "loading" ? (
          <p role="status">Loading reward details…</p>
        ) : null}
        {status === "error" ? (
          <div className="timeline-details-message" role="alert">
            <p>
              Some reward details could not load. Your choices are still saved.
            </p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}
        {choices.length ? (
          <ul>
            {choices.map(([id, included]) => {
              const reward = metadata.get(id);
              const event = reward?.event;
              return (
                <li
                  key={id}
                  className="timeline-change-row"
                  data-change="reward"
                >
                  {reward ? (
                    <>
                      <strong>{englishRewardLabel(reward.name)}</strong>
                      <span>
                        {reward.amount.toLocaleString("en")}{" "}
                        {incomeResourceLabels[reward.itemType]} ·{" "}
                        {included ? "Include" : "Exclude"}
                      </span>
                      <small>
                        {reward.expectedAt
                          ? calendarDayKey(
                              reward.expectedAt,
                              reward.expectedAtPrecision,
                              timeZone,
                            )
                          : "No forecast date"}
                      </small>
                    </>
                  ) : (
                    <>
                      <strong>Reward choice</strong>
                      <small>
                        {included ? "Include" : "Exclude"} ·{" "}
                        {status === "ready"
                          ? "Reward details unavailable"
                          : "Details not loaded"}
                      </small>
                      <small>Reference: {id}</small>
                    </>
                  )}
                  <div className="timeline-reward-decision-actions">
                    {event ? (
                      <button
                        type="button"
                        disabled={opening}
                        onClick={() => void open(() => onOpenReward(event))}
                      >
                        Open {event.name}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => onResetReward(id)}>
                      Use automatic
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No explicit reward choices. Rewards use automatic inclusion.</p>
        )}
      </section>
    </aside>
  );
}
