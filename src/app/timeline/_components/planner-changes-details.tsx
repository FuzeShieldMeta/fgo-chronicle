"use client";
import { TimelinePanelHeader } from "./timeline-panel-header";
import { ResourceLabel } from "./resource-label";
import { formatCalendarDay } from "../_lib/schedule-date";

import { useMemo, useState } from "react";
import type { RewardPreferences } from "../_lib/reward-preferences";
import {
  compareSummonSessions,
  type SummonSession,
} from "../_lib/summon-session";
import { calculateSummonCost } from "../_lib/summon-cost";
import { summonSessionBalances } from "../_lib/income-ledger";
import type { IncomeLedgerCell } from "../_lib/income-ledger";
import { englishRewardLabel } from "../_lib/reward-labels";
import { calendarDayKey } from "../_lib/schedule-layout";
import type { RewardChoiceDetails } from "./use-reward-choice-details";
import type { TimelineSearchEntry } from "~/shared/timeline-search";
import {
  servantAtlasUrl,
  type FeaturedServant,
} from "~/shared/featured-servants";
import type { PlayerForecastProfile } from "../_lib/player-forecast";
import { ServantIdentity } from "./servant-thumbnail";
import { timelineLayout } from "../_lib/timeline-layout-config";

export function PlannerChangesDetails({
  sessions,
  preferences,
  rewards,
  ledgerCells,
  entries = [],
  servants = [],
  servantLookupFailed = false,
  onRetryServants,
  forecast,
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
  entries?: readonly (Pick<
    TimelineSearchEntry,
    "key" | "name" | "startsAt" | "startsAtPrecision"
  > & { featuredServants?: readonly FeaturedServant[] })[];
  servants?: readonly FeaturedServant[];
  servantLookupFailed?: boolean;
  onRetryServants?: () => void;
  forecast?: {
    ready: boolean;
    throughDay: string;
    profile: PlayerForecastProfile | null;
  };
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
  const sessionBalances = useMemo(
    () =>
      forecast?.ready
        ? summonSessionBalances({
            cells: ledgerCells,
            sessions,
            profile: forecast.profile,
            fromDay,
            throughDay: forecast.throughDay,
          })
        : new Map<string, never>(),
    [
      ledgerCells,
      sessions,
      forecast?.ready,
      forecast?.profile,
      forecast?.throughDay,
      fromDay,
    ],
  );
  const metadata = new Map(rewards.map((reward) => [reward.id, reward]));
  const events = new Map(entries.map((entry) => [entry.key, entry]));
  const servantById = new Map(servants.map((servant) => [servant.id, servant]));
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
      <TimelinePanelHeader
        title="Changes"
        headingId="timeline-changes-heading"
        eyebrow="Planner"
        onClose={onClose}
      />
      <p className="summon-helper-text">
        Your saved summon sessions and reward choices. Starting balances are
        under Balances.
      </p>
      {opening ? <p role="status">Opening the timeline…</p> : null}
      {error ? <p role="alert">This entry could not open. Try again.</p> : null}
      <section className="timeline-detail-section">
        <h3>Summons ({sessions.length})</h3>
        {servantLookupFailed ? (
          <div className="timeline-details-message" role="alert">
            <p>
              Some servant details could not load. Your plans are still saved.
            </p>
            {onRetryServants ? (
              <button type="button" onClick={onRetryServants}>
                Retry servant details
              </button>
            ) : null}
          </div>
        ) : null}
        {sessions.length ? (
          <p>
            Balances include income and earlier plans. Same-day plans use
            creation order.
          </p>
        ) : null}
        {sessions.length ? (
          <ul>
            {[...sessions].sort(compareSummonSessions).map((session) => {
              const cost = calculateSummonCost({
                ...session.spending,
                startingBonusCount: session.startingBonusCount,
              });
              const outsideTimeline =
                session.day < fromDay || session.day > throughDay;
              const balances = sessionBalances.get(session.id);
              const banner = events.get(`banner:${session.banner.id}`);
              const servant =
                (session.target.servantId === null
                  ? undefined
                  : servantById.get(session.target.servantId)) ??
                banner?.featuredServants?.find(
                  (servant) => servant.id === session.target.servantId,
                );
              const servantUrl = servant ? servantAtlasUrl(servant) : null;
              const identity = (
                <ServantIdentity
                  name={session.target.name}
                  className={servant?.className}
                  thumbnailUrl={servant?.thumbnailUrl}
                  size={timelineLayout.servantDetailsThumbnailSize}
                />
              );
              return (
                <li
                  key={session.id}
                  className="timeline-change-row"
                  data-change="summon"
                >
                  <div className="timeline-change-summon-heading">
                    {servantUrl ? (
                      <a
                        className="timeline-servant-link timeline-change-servant"
                        href={servantUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${session.target.name} - Atlas Academy Servant Page (opens in a new tab)`}
                      >
                        {identity}
                      </a>
                    ) : (
                      <div className="timeline-change-servant">{identity}</div>
                    )}
                    <span className="timeline-change-campaign">
                      {session.banner.name}
                    </span>
                    <div className="timeline-change-plan-actions">
                      <span>
                        <time dateTime={session.day}>
                          {formatCalendarDay(session.day)}
                        </time>{" "}
                        · {cost.totalResults.toLocaleString("en")} summons
                      </span>
                      <button
                        type="button"
                        className="timeline-tonal-button"
                        disabled={opening || outsideTimeline}
                        aria-label={`Edit plan for ${session.target.name} on ${session.day}`}
                        onClick={() => void open(() => onOpenSession(session))}
                      >
                        Edit plan
                      </button>
                    </div>
                    {outsideTimeline ? (
                      <small>Outside the current timeline</small>
                    ) : null}
                  </div>
                  <div className="timeline-change-summon-resources">
                    {!balances ? (
                      <p className="summon-helper-text">
                        {cost.quartzSpent.toLocaleString("en")} SQ ·{" "}
                        {cost.ticketsSpent.toLocaleString("en")} tickets
                        {cost.fragmentsConverted
                          ? ` · ${cost.fragmentsConverted.toLocaleString("en")} fragments converted`
                          : ""}
                      </p>
                    ) : null}
                    {balances ? (
                      <dl
                        className="timeline-change-balances"
                        aria-label={`Resources for ${session.target.name}`}
                      >
                        {(
                          [
                            [
                              "SAINT_QUARTZ",
                              [
                                cost.quartzFromFragments
                                  ? `+${cost.quartzFromFragments.toLocaleString("en")} converted`
                                  : null,
                                cost.quartzSpent
                                  ? `−${cost.quartzSpent.toLocaleString("en")} spent`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · "),
                            ],
                            [
                              "SUMMON_TICKET",
                              cost.ticketsSpent
                                ? `−${cost.ticketsSpent.toLocaleString("en")} spent`
                                : null,
                            ],
                            [
                              "SAINT_QUARTZ_FRAGMENT",
                              cost.fragmentsConverted
                                ? `−${cost.fragmentsConverted.toLocaleString("en")} converted`
                                : null,
                            ],
                          ] as const
                        ).map(([resource, spending]) => (
                          <div key={resource} data-resource={resource}>
                            <dt>
                              <ResourceLabel resource={resource} compact />
                            </dt>
                            <dd>
                              <span className="timeline-change-balance-values">
                                <span>
                                  <span className="sr-only">Before: </span>
                                  {balances.before[resource].toLocaleString(
                                    "en",
                                  )}
                                </span>
                                <span aria-hidden="true">→</span>
                                <span
                                  data-shortfall={
                                    balances.after[resource] < 0
                                      ? "true"
                                      : undefined
                                  }
                                >
                                  <span className="sr-only">After: </span>
                                  {balances.after[resource].toLocaleString(
                                    "en",
                                  )}
                                </span>
                              </span>
                              {spending ? <small>{spending}</small> : null}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="summon-helper-text">
                        {session.day < fromDay ||
                        session.day <
                          (forecast?.profile?.snapshot.effectiveDate ?? fromDay)
                          ? "Before/after balances are unavailable before the forecast starting point."
                          : session.day > throughDay
                            ? "Before/after balances are outside the current forecast."
                            : "Before/after balances will appear when forecast income has loaded."}
                      </p>
                    )}
                    {balances &&
                    [
                      balances.after.SAINT_QUARTZ,
                      balances.after.SUMMON_TICKET,
                      balances.after.SAINT_QUARTZ_FRAGMENT,
                    ].some((value) => value < 0) ? (
                      <p className="summon-affordability-note">
                        Resource shortfall after this plan.
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No summon sessions saved.</p>
        )}
      </section>
      <section className="timeline-detail-section">
        <h3>Reward choices ({choices.length})</h3>
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
                        <ResourceLabel resource={reward.itemType} /> ·{" "}
                        {included ? "Include" : "Exclude"}
                      </span>
                      <small>
                        {reward.expectedAt
                          ? formatCalendarDay(
                              calendarDayKey(
                                reward.expectedAt,
                                reward.expectedAtPrecision,
                                timeZone,
                              ),
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
