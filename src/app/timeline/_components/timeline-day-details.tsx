"use client";
import { TimelinePanelHeader } from "./timeline-panel-header";
import { formatCalendarDay } from "../_lib/schedule-date";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  SummonPlanPanel,
  type SummonPlanSpending,
} from "~/app/timeline/_components/summon-plan-panel";
import {
  SummonProbabilityPanel,
  type SummonProbabilitySettings,
} from "~/app/timeline/_components/summon-probability-panel";
import type { ForecastBalances } from "~/app/timeline/_lib/player-forecast";
import type { summonSessionBalances } from "~/app/timeline/_lib/income-ledger";
import {
  resolveAutomaticSummonRate,
  standardSummonRateEvidenceUrl,
} from "~/app/timeline/_lib/summon-rate";
import type { SummonSession } from "~/app/timeline/_lib/summon-session";
import { calendarDayKey } from "~/app/timeline/_lib/schedule-layout";
import { timelineSchedule } from "~/app/timeline/_lib/timeline-layout-config";
import { api } from "~/trpc/react";

export type TimelineDayBanner = {
  id: string;
  name: string;
};

const initialSpending: SummonPlanSpending = {
  multis: 1,
  quartzSingles: 0,
  tickets: 0,
  fragmentsConverted: 0,
  startingBonusCount: 0,
  autoConvertFragments: false,
};

function spendingForSession(session: SummonSession): SummonPlanSpending {
  return {
    ...session.spending,
    startingBonusCount: session.startingBonusCount,
    autoConvertFragments: false,
  };
}

const summonTabs = ["PLAN", "PROBABILITY"] as const;
type SummonTab = (typeof summonTabs)[number];

export function TimelineDayDetails({
  day,
  banners,
  balances,
  sessions,
  initialBannerId,
  initialServantId,
  initialSessionId,
  sessionBalances,
  onSave,
  onUpdate,
  onDuplicate,
  onMove,
  onDelete,
  findAffordableDay,
  scheduleStartDay,
  scheduleEndDay,
  timeZone,
  onClose,
}: {
  day: string;
  banners: TimelineDayBanner[];
  balances: ForecastBalances;
  sessions: SummonSession[];
  initialBannerId?: string | null;
  initialServantId?: number | null;
  initialSessionId?: string | null;
  sessionBalances?: ReturnType<typeof summonSessionBalances>;
  onSave: (session: SummonSession) => void;
  onUpdate: (session: SummonSession) => void;
  onDuplicate: (sessionId: string) => void;
  onMove: (sessionId: string, day: string) => void;
  onDelete: (sessionId: string) => void;
  findAffordableDay?: (
    spending: SummonPlanSpending,
    excludedSessionId?: string,
  ) => string | null;
  scheduleStartDay?: string;
  scheduleEndDay?: string;
  timeZone: string;
  onClose: () => void;
}) {
  const initialSession = sessions.find(
    (session) => session.id === initialSessionId && session.day === day,
  );
  const [tab, setTab] = useState<SummonTab>("PLAN");
  const tabRefs = useRef<Record<SummonTab, HTMLButtonElement | null>>({
    PLAN: null,
    PROBABILITY: null,
  });
  const [selectedBannerId, setSelectedBannerId] = useState(
    initialSession?.banner.id ?? initialBannerId ?? banners[0]?.id ?? "",
  );
  const [selectedServantId, setSelectedServantId] = useState(
    String(
      initialSession
        ? (initialSession.target.servantId ?? "")
        : (initialServantId ?? ""),
    ),
  );
  const [selectedLineupId, setSelectedLineupId] = useState("");
  const [customTargetName, setCustomTargetName] = useState(
    initialSession?.target.name ?? "",
  );
  const [startingNp, setStartingNp] = useState(
    initialSession?.target.startingNp ?? 0,
  );
  const [rateSelection, setRateSelection] = useState<
    "AUTOMATIC" | "ENTERED" | null
  >(
    initialSession && initialSession.target.rateKind !== "STANDARD_PRESET"
      ? "ENTERED"
      : null,
  );
  const [customRatePercent, setCustomRatePercent] = useState(
    initialSession ? initialSession.target.rate * 100 : 0.8,
  );
  const [customGuaranteedEligible, setCustomGuaranteedEligible] = useState(
    initialSession?.target.guaranteedEligible ?? true,
  );
  const [currentGuaranteedCount, setCurrentGuaranteedCount] = useState(
    initialSession?.startingGuaranteedCount ?? 0,
  );
  const [spending, setSpending] = useState<SummonPlanSpending>(() =>
    initialSession ? spendingForSession(initialSession) : initialSpending,
  );
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const editingSession = editingSessionId
    ? (sessions.find(
        (session) => session.id === editingSessionId && session.day === day,
      ) ?? null)
    : null;

  const details = api.timeline.details.useQuery(
    { kind: "BANNER", id: selectedBannerId || "unselected" },
    {
      enabled: Boolean(selectedBannerId),
      staleTime: timelineSchedule.detailsStaleTimeMs,
    },
  );
  const data =
    details.data?.kind === "BANNER" && details.data.id === selectedBannerId
      ? details.data
      : undefined;
  const waitingForBanner =
    Boolean(selectedBannerId) && !data && !details.isError;
  const bannerFeatured = data?.featured ?? [];
  const lineups = data?.summonLineups ?? [];
  const activeLineups = lineups.filter((lineup) => {
    const starts = calendarDayKey(lineup.startsAt, "EXACT", timeZone);
    const ends = lineup.endsAt
      ? calendarDayKey(lineup.endsAt, "EXACT", timeZone)
      : starts;
    return day >= starts && day <= ends;
  });
  const selectedLineup =
    activeLineups.find((lineup) => lineup.id === selectedLineupId) ??
    activeLineups.find(
      (lineup) => lineup.sourceKey === editingSession?.banner.lineupKey,
    ) ??
    activeLineups.find((lineup) =>
      lineup.featured.some(
        ({ servant }) => String(servant.id) === selectedServantId,
      ),
    ) ??
    activeLineups[0];
  const featured = selectedLineup?.featured.length
    ? selectedLineup.featured
    : bannerFeatured;
  const matchedFeatured = featured.find(
    ({ servant }) => String(servant.id) === selectedServantId,
  );
  const selectedFeatured = selectedServantId ? matchedFeatured : featured[0];
  const selectedServant = selectedFeatured?.servant;
  const savedTargetIsOutsideLineup = Boolean(
    selectedServantId && !matchedFeatured && customTargetName.trim(),
  );
  const selectedBanner = banners.find(({ id }) => id === selectedBannerId);
  const savedBannerIsOutsideSchedule = Boolean(
    editingSession &&
    !selectedBanner &&
    editingSession.banner.id === selectedBannerId,
  );
  const effectiveBanner =
    selectedBanner ??
    (savedBannerIsOutsideSchedule ? editingSession?.banner : undefined);
  const effectiveLineupKey = savedBannerIsOutsideSchedule
    ? editingSession?.banner.lineupKey
    : (selectedLineup?.sourceKey ??
      (effectiveBanner ? `banner:${effectiveBanner.id}` : undefined));
  const targetName = selectedServant?.name ?? customTargetName.trim();
  const targetServantId =
    selectedServant?.id ??
    (selectedServantId && Number.isSafeInteger(Number(selectedServantId))
      ? Number(selectedServantId)
      : null);
  const sharedCount = selectedFeatured?.soloRateUp
    ? 1
    : Math.max(
        2,
        featured.filter(
          (candidate) =>
            !candidate.soloRateUp &&
            candidate.servant.rarity === selectedServant?.rarity,
        ).length,
      );
  const automaticRate = resolveAutomaticSummonRate({
    rarity: selectedServant?.rarity,
    soloRateUp: selectedFeatured?.soloRateUp ?? true,
    sharedCount,
  });
  const effectiveRateSelection =
    rateSelection ?? (automaticRate ? "AUTOMATIC" : "ENTERED");
  const selectedAutomaticRate =
    effectiveRateSelection === "AUTOMATIC" ? automaticRate : null;
  const rate = selectedAutomaticRate
    ? selectedAutomaticRate.rate
    : customRatePercent / 100;
  const guaranteedEligible = selectedAutomaticRate
    ? selectedAutomaticRate.guaranteedEligible
    : customGuaranteedEligible;
  const probabilitySettings: SummonProbabilitySettings = {
    startingNp,
    currentGuaranteedCount: guaranteedEligible ? currentGuaranteedCount : 0,
    rate,
    guaranteedEligible,
  };
  const planTarget = targetName
    ? {
        servantId: targetServantId,
        name: targetName,
        startingNp,
        rate,
        rateKind: selectedAutomaticRate
          ? ("STANDARD_PRESET" as const)
          : ("CUSTOM" as const),
        rateEvidenceUrl: selectedAutomaticRate
          ? standardSummonRateEvidenceUrl
          : null,
        guaranteedEligible,
        startingGuaranteedCount: guaranteedEligible
          ? currentGuaranteedCount
          : 0,
      }
    : null;
  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    [sessions],
  );
  const earliestAffordableDay = useMemo(
    () => findAffordableDay?.(spending, editingSession?.id),
    [editingSession?.id, findAffordableDay, spending],
  );

  function editSession(session: SummonSession) {
    setSelectedBannerId(session.banner.id);
    setSelectedLineupId("");
    setSelectedServantId(String(session.target.servantId ?? ""));
    setCustomTargetName(session.target.name);
    setStartingNp(session.target.startingNp);
    setRateSelection(
      session.target.rateKind === "STANDARD_PRESET" ? null : "ENTERED",
    );
    setCustomRatePercent(session.target.rate * 100);
    setCustomGuaranteedEligible(session.target.guaranteedEligible);
    setCurrentGuaranteedCount(session.startingGuaranteedCount);
    setSpending(spendingForSession(session));
    setEditingSessionId(session.id);
    setTab("PLAN");
    setSavedMessage(null);
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: SummonTab,
  ) {
    const currentIndex = summonTabs.indexOf(currentTab);
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % summonTabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + summonTabs.length) % summonTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = summonTabs.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = summonTabs[nextIndex];
    if (!nextTab) return;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  if (editingSessionId && !editingSession) {
    return (
      <aside
        className="timeline-details timeline-day-details"
        data-empty="false"
        aria-labelledby="timeline-day-heading"
      >
        <TimelinePanelHeader
          title="Summon planning"
          headingId="timeline-day-heading"
          onClose={onClose}
        />
        <div className="timeline-details-message" role="alert">
          <p>
            This plan is no longer available on this date. It may have been
            deleted or moved. Reopen Changes to select a saved plan.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="timeline-details timeline-day-details"
      data-empty="false"
      aria-labelledby="timeline-day-heading"
    >
      <div className="timeline-details-handle" aria-hidden="true" />
      <TimelinePanelHeader
        title={formatCalendarDay(day)}
        headingId="timeline-day-heading"
        eyebrow="Summon planning"
        onClose={onClose}
        closeLabel="Close day details"
      />

      <h3 className="summon-section-title">Campaign and target</h3>
      {banners.length > 0 ? (
        <label className="summon-field">
          Summoning campaign
          <select
            value={selectedBannerId}
            onChange={(event) => {
              setSelectedBannerId(event.target.value);
              setSelectedServantId("");
              setSelectedLineupId("");
              setRateSelection(null);
              setSavedMessage(null);
            }}
          >
            {savedBannerIsOutsideSchedule && editingSession ? (
              <option value={editingSession.banner.id}>
                {editingSession.banner.name} · saved snapshot
              </option>
            ) : null}
            {banners.map((banner) => (
              <option key={banner.id} value={banner.id}>
                {banner.name}
              </option>
            ))}
          </select>
          {savedBannerIsOutsideSchedule ? (
            <small>This saved campaign is not active on this date.</small>
          ) : null}
        </label>
      ) : (
        <p className="timeline-details-message">
          No summoning campaign is active on this date.
        </p>
      )}

      {activeLineups.length > 0 ? (
        <label className="summon-field">
          Summon lineup
          <select
            value={selectedLineup?.id ?? ""}
            onChange={(event) => {
              setSelectedLineupId(event.target.value);
              setRateSelection(null);
              setSavedMessage(null);
            }}
          >
            {activeLineups.map((lineup) => (
              <option key={lineup.id} value={lineup.id}>
                {lineup.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {waitingForBanner ? (
        <p
          className="timeline-details-message"
          data-state="loading"
          role="status"
        >
          Loading featured servants…
        </p>
      ) : null}
      {selectedBannerId && details.isError ? (
        <div
          className="timeline-details-message"
          data-state="error"
          role="alert"
        >
          <p>
            {data
              ? "Showing the last loaded lineup. The update failed."
              : "Featured servants could not load. You can enter a target manually."}
          </p>
          <button type="button" onClick={() => details.refetch()}>
            Retry campaign details
          </button>
        </div>
      ) : data && details.isFetching ? (
        <p
          className="timeline-details-message"
          data-state="refreshing"
          role="status"
        >
          Updating campaign details…
        </p>
      ) : null}
      {data && featured.length === 0 ? (
        <p>No featured servants are listed for this campaign.</p>
      ) : null}

      {featured.length > 0 ? (
        <label className="summon-field">
          Target Servant
          <select
            value={selectedServantId || String(selectedServant?.id ?? "")}
            onChange={(event) => {
              setSelectedServantId(event.target.value);
              setRateSelection(null);
            }}
          >
            {savedTargetIsOutsideLineup ? (
              <option value={selectedServantId}>{customTargetName}</option>
            ) : null}
            {selectedServantId &&
            !matchedFeatured &&
            !savedTargetIsOutsideLineup ? (
              <option value={selectedServantId} disabled>
                Selected servant unavailable in this lineup
              </option>
            ) : null}
            {featured.map(({ servant, soloRateUp }) => (
              <option key={servant.id} value={servant.id}>
                {servant.name} · {servant.rarity ? `★${servant.rarity} · ` : ""}
                {soloRateUp ? "solo" : "shared"}
              </option>
            ))}
          </select>
          {savedTargetIsOutsideLineup ? (
            <small>This saved target is not in the current lineup data.</small>
          ) : null}
        </label>
      ) : selectedBannerId && !waitingForBanner ? (
        <label className="summon-field">
          Target Servant
          <input
            type="text"
            value={customTargetName}
            onChange={(event) => setCustomTargetName(event.target.value)}
            placeholder="Enter a target name"
          />
        </label>
      ) : null}

      <div className="summon-field-grid summon-shared-settings">
        <label className="summon-field">
          Current NP level
          <select
            value={startingNp}
            onChange={(event) => setStartingNp(Number(event.target.value))}
          >
            {[0, 1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                NP{value}
              </option>
            ))}
          </select>
        </label>
        <label className="summon-field">
          Target rate
          <select
            value={effectiveRateSelection}
            onChange={(event) =>
              setRateSelection(event.target.value as "AUTOMATIC" | "ENTERED")
            }
          >
            {automaticRate ? (
              <option value="AUTOMATIC">{automaticRate.label}</option>
            ) : null}
            <option value="ENTERED">Enter another rate</option>
          </select>
          {automaticRate ? null : (
            <small>Rarity is unavailable. Enter the target rate.</small>
          )}
        </label>
        {effectiveRateSelection === "ENTERED" ? (
          <label className="summon-field">
            Rate percentage
            <input
              type="number"
              min="0.0001"
              max="100"
              step="0.0001"
              value={customRatePercent}
              onChange={(event) =>
                setCustomRatePercent(
                  Math.min(100, Math.max(0.0001, Number(event.target.value))),
                )
              }
            />
          </label>
        ) : null}
        {effectiveRateSelection === "ENTERED" ? (
          <label className="summon-checkbox-field">
            <input
              type="checkbox"
              checked={customGuaranteedEligible}
              onChange={(event) =>
                setCustomGuaranteedEligible(event.target.checked)
              }
            />
            Apply the 330-summon guarantee
          </label>
        ) : null}
        {guaranteedEligible ? (
          <label className="summon-field">
            Pity progress
            <input
              type="number"
              min="0"
              max="329"
              step="1"
              inputMode="numeric"
              value={currentGuaranteedCount}
              onChange={(event) =>
                setCurrentGuaranteedCount(
                  Math.min(329, Math.max(0, Number(event.target.value))),
                )
              }
            />
          </label>
        ) : null}
      </div>
      <div className="summon-tabs" role="tablist" aria-label="Summon tools">
        <button
          ref={(element) => {
            tabRefs.current.PLAN = element;
          }}
          id="summon-plan-tab"
          type="button"
          role="tab"
          aria-selected={tab === "PLAN"}
          aria-controls="summon-plan-panel"
          tabIndex={tab === "PLAN" ? 0 : -1}
          onClick={() => setTab("PLAN")}
          onKeyDown={(event) => handleTabKeyDown(event, "PLAN")}
        >
          Plan
        </button>
        <button
          ref={(element) => {
            tabRefs.current.PROBABILITY = element;
          }}
          id="summon-probability-tab"
          type="button"
          role="tab"
          aria-selected={tab === "PROBABILITY"}
          aria-controls="summon-probability-panel"
          tabIndex={tab === "PROBABILITY" ? 0 : -1}
          onClick={() => setTab("PROBABILITY")}
          onKeyDown={(event) => handleTabKeyDown(event, "PROBABILITY")}
        >
          Probability
        </button>
      </div>

      {tab === "PLAN" ? (
        <div
          id="summon-plan-panel"
          role="tabpanel"
          aria-labelledby="summon-plan-tab"
        >
          <SummonPlanPanel
            day={day}
            banner={
              effectiveBanner
                ? {
                    ...effectiveBanner,
                    lineupKey: effectiveLineupKey!,
                  }
                : null
            }
            target={planTarget}
            balances={
              editingSession
                ? (sessionBalances?.get(editingSession.id)?.after ?? balances)
                : balances
            }
            spending={spending}
            onSpendingChange={setSpending}
            onSave={(session) => {
              if (editingSession) onUpdate(session);
              else onSave(session);
              setEditingSessionId(session.id);
              setSavedMessage(
                `${editingSession ? "Plan updated" : "Plan saved"} for ${formatCalendarDay(session.day)}.`,
              );
            }}
            earliestAffordableDay={earliestAffordableDay}
            editingSession={editingSession}
          />
        </div>
      ) : (
        <div
          id="summon-probability-panel"
          role="tabpanel"
          aria-labelledby="summon-probability-tab"
        >
          <SummonProbabilityPanel
            settings={probabilitySettings}
            onUsePlan={({ multis, singles }) => {
              setSpending((current) => ({
                ...current,
                multis,
                quartzSingles: singles,
                tickets: 0,
              }));
              setTab("PLAN");
            }}
          />
        </div>
      )}

      {savedMessage ? (
        <p className="summon-save-message" role="status">
          {savedMessage}
        </p>
      ) : null}

      {sortedSessions.length === 0 ? (
        <p>No summons planned for this date.</p>
      ) : null}
      {sortedSessions.length > 0 ? (
        <section
          className="summon-saved-sessions"
          aria-labelledby="saved-sessions-heading"
        >
          <h3 id="saved-sessions-heading">Sessions on this day</h3>
          <ul>
            {sortedSessions.map((session) => (
              <li key={session.id}>
                <div>
                  <strong>{session.target.name}</strong>
                  <small>
                    {session.spending.multis} multis ·{" "}
                    {session.spending.tickets} tickets
                  </small>
                </div>
                <div className="summon-session-actions">
                  <button type="button" onClick={() => editSession(session)}>
                    Edit
                  </button>
                  <button type="button" onClick={() => onDuplicate(session.id)}>
                    Duplicate
                  </button>
                  {pendingDeleteId === session.id ? (
                    <>
                      <button
                        type="button"
                        className="summon-danger-button"
                        onClick={() => {
                          onDelete(session.id);
                          setPendingDeleteId(null);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPendingDeleteId(session.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <form
                  className="summon-move-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const nextDay = data.get("day");
                    if (typeof nextDay === "string") {
                      onMove(session.id, nextDay);
                    }
                  }}
                >
                  <label className="summon-field">
                    Move to date
                    <input
                      type="date"
                      name="day"
                      defaultValue={session.day}
                      min={scheduleStartDay}
                      max={scheduleEndDay}
                      required
                    />
                  </label>
                  <button type="submit">Move</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
