"use client";
import {
  StoryCatalogueContext,
  useStoryCatalogue,
} from "./story-catalogue-provider";
import { storyChapters, type StoryChapter } from "../_lib/story-progress";

import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import {
  TimelineIncomeDetails,
  TimelineDetailsPlaceholder,
  TimelineEntryDetails,
  TimelineProfileDetails,
} from "~/app/timeline/_components/timeline-entry-details";
import { TimelineIncomeLedger } from "~/app/timeline/_components/timeline-income-ledger";
import { TimelineDayDetails } from "~/app/timeline/_components/timeline-day-details";
import { TimelineDayClickDemo } from "~/app/timeline/_components/timeline-day-click-demo";
import { TimelineDetailsLayer } from "~/app/timeline/_components/timeline-details-layer";
import {
  TimelineAccountMenu,
  type TimelineAccountUser,
} from "~/app/timeline/_components/timeline-account-menu";
import { TimelineAccountDetails } from "~/app/timeline/_components/timeline-account-details";
import { PlannerSyncConflictDialog } from "~/app/timeline/_components/planner-sync-conflict-dialog";
import { usePlannerStateSync } from "~/app/timeline/_components/use-planner-state-sync";
import {
  buildIncomeLedger,
  findEarliestAffordableSummonDay,
  forecastBalancesOnDay,
  incomeResourceIcons,
  incomeResourceLabels,
} from "~/app/timeline/_lib/income-ledger";
import {
  forecastResourceTypes,
  clearPlayerForecastProfile,
  loadPlayerForecastProfile,
  savePlayerForecastProfile,
  type PlayerForecastProfile,
} from "~/app/timeline/_lib/player-forecast";
import { createPlannerStatePayload } from "~/app/timeline/_lib/planner-state";
import {
  createRewardPreferences,
  loadRewardPreferences,
  saveRewardPreferences,
  setRewardInclusion,
  type RewardPreferences,
} from "~/app/timeline/_lib/reward-preferences";
import {
  deleteSummonSession,
  duplicateSummonSession,
  loadSummonSessions,
  moveSummonSession,
  saveSummonSessions,
  setSummonSessionStatus,
  type SummonSession,
  type SummonSessionStatus,
} from "~/app/timeline/_lib/summon-session";
import type { SummonPlanSpending } from "~/app/timeline/_components/summon-plan-panel";
import {
  calendarDayKey,
  calendarDays,
  laneSharePercent,
  layoutSchedule,
  visibleDayIndex,
  type ScheduleCategoryLayout,
  type ScheduleInterval,
} from "~/app/timeline/_lib/schedule-layout";
import {
  timelineLayout,
  timelineSchedule,
} from "~/app/timeline/_lib/timeline-layout-config";
import { horizontalWheelDelta } from "~/app/timeline/_lib/timeline-wheel";
import {
  artworkUrlAfterFailure,
  railArtworkUrl,
} from "~/app/timeline/_lib/timeline-rail-artwork";
import { positionViewportTooltip } from "~/app/timeline/_lib/viewport-tooltip";
import type { RouterOutputs } from "~/trpc/react";

type TimelineEntry = RouterOutputs["timeline"]["list"][number];
type TimelineIncomeContribution = RouterOutputs["timeline"]["income"][number];
type LedgerEntry = TimelineEntry & ScheduleInterval;

const categoryNames = {
  EVENT: "Events",
  SUMMONING_CAMPAIGN: "Summoning campaigns",
  INCOME_SOURCE: "Income sources",
} as const;

const statusNames = {
  OFFICIAL: "Official",
  CURATED: "Curated",
  PROJECTED: "Projected",
} as const;

type LocalCalendar = {
  today: string;
  timeZone: string;
};

type RailTooltip = {
  key: string;
  name: string;
  x: number;
  y: number;
  placement: "above" | "below";
};

type PlanDemo = {
  day: string;
  runId: number;
};

function scheduleEndDay(dayKey: string) {
  const value = new Date(`${dayKey}T00:00:00.000Z`);
  value.setUTCFullYear(value.getUTCFullYear() + timelineSchedule.yearsAhead);
  return value.toISOString().slice(0, 10);
}

function readLocalCalendar(): LocalCalendar {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    today: calendarDayKey(new Date(), "EXACT", timeZone),
    timeZone,
  };
}

function dateLabel(dayKey: string, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(`${dayKey}T00:00:00.000Z`));
  const values = new Map(parts.map(({ type, value }) => [type, value]));

  return {
    day: values.get("day"),
    month: values.get("month"),
    weekday: values.get("weekday"),
  };
}

function intervalLabel(entry: TimelineEntry, timeZone: string) {
  const start = calendarDayKey(
    entry.startsAt,
    entry.startsAtPrecision,
    timeZone,
  );
  const end = entry.endsAt
    ? calendarDayKey(entry.endsAt, entry.endsAtPrecision ?? "EXACT", timeZone)
    : start;

  return `${entry.name}. ${statusNames[entry.status]}. ${start} to ${end}.`;
}

function Rail({
  entry,
  selected,
  timeZone,
  onSelect,
  onShowTooltip,
  onHideTooltip,
}: {
  entry: ScheduleCategoryLayout<LedgerEntry>["items"][number];
  selected: boolean;
  timeZone: string;
  onSelect: (entry: TimelineEntry) => void;
  onShowTooltip: (
    entry: TimelineEntry,
    target: HTMLButtonElement,
    pointerX?: number,
    pointerY?: number,
  ) => void;
  onHideTooltip: (key: string) => void;
}) {
  const density =
    entry.groupLaneCount <= timelineLayout.comfortableLaneCount
      ? "comfortable"
      : entry.groupLaneCount <= timelineLayout.compactLaneCount
        ? "compact"
        : "dense";
  const laneShare = laneSharePercent(entry.groupLaneCount);
  const laneInset =
    entry.groupLaneCount <= timelineLayout.maximumInsetLaneCount
      ? timelineLayout.railLaneInset
      : 0;
  const railWidth =
    (entry.endRow - entry.startRow + 1) * timelineLayout.dayWidth -
    timelineLayout.railHorizontalInset * 2;
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(null);
  const candidateArtworkUrl = railArtworkUrl(entry, {
    availableWidth: railWidth,
    minimumWidth: timelineLayout.minimumEventArtworkRailWidth,
  });
  const artworkUrl = artworkUrlAfterFailure(
    candidateArtworkUrl,
    failedArtworkUrl,
  );
  const style = {
    top: `calc(${entry.lane * laneShare}% + ${laneInset}px)`,
    left:
      entry.startRow * timelineLayout.dayWidth +
      timelineLayout.railHorizontalInset,
    width: railWidth,
    height: `calc(${laneShare}% - ${laneInset * 2}px)`,
  } as CSSProperties;

  return (
    <div
      className="timeline-rail"
      data-status={entry.status}
      data-selected={selected ? "true" : "false"}
      data-density={density}
      style={style}
    >
      <button
        type="button"
        className="timeline-rail-action"
        aria-label={intervalLabel(entry, timeZone)}
        aria-pressed={selected}
        onClick={() => {
          onHideTooltip(entry.key);
          onSelect(entry);
        }}
        onPointerEnter={(event) =>
          onShowTooltip(
            entry,
            event.currentTarget,
            event.clientX,
            event.clientY,
          )
        }
        onPointerLeave={() => onHideTooltip(entry.key)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            onShowTooltip(entry, event.currentTarget);
          }
        }}
        onBlur={() => onHideTooltip(entry.key)}
      />
      <span className="timeline-rail-start" aria-hidden="true" />
      <span className="timeline-rail-label-track" aria-hidden="true">
        <span
          className="timeline-rail-name"
          data-has-artwork={artworkUrl ? "true" : undefined}
        >
          {artworkUrl ? (
            <Image
              className="timeline-rail-artwork"
              src={artworkUrl}
              alt=""
              width={timelineLayout.eventBannerIntrinsicWidth}
              height={timelineLayout.eventBannerIntrinsicHeight}
              sizes={timelineLayout.eventRailArtworkSizes}
              loading="lazy"
              onError={() => setFailedArtworkUrl(artworkUrl)}
            />
          ) : null}
          <span className="timeline-rail-name-text">{entry.name}</span>
        </span>
      </span>
      <span className="timeline-rail-end" aria-hidden="true" />
    </div>
  );
}

function CategoryRow({
  layout,
  selectedKey,
  timeZone,
  onSelect,
  onShowTooltip,
  onHideTooltip,
}: {
  layout: ScheduleCategoryLayout<LedgerEntry>;
  selectedKey: string | null;
  timeZone: string;
  onSelect: (entry: TimelineEntry) => void;
  onShowTooltip: (
    entry: TimelineEntry,
    target: HTMLButtonElement,
    pointerX?: number,
    pointerY?: number,
  ) => void;
  onHideTooltip: (key: string) => void;
}) {
  return (
    <section
      className="timeline-category"
      data-category={layout.category}
      aria-label={`${categoryNames[layout.category]} timeline`}
    >
      <div className="timeline-rail-canvas">
        {layout.items.map((entry) => (
          <Rail
            key={entry.key}
            entry={entry}
            selected={entry.key === selectedKey}
            timeZone={timeZone}
            onSelect={onSelect}
            onShowTooltip={onShowTooltip}
            onHideTooltip={onHideTooltip}
          />
        ))}
      </div>
    </section>
  );
}

export function TimelineSchedule(props: {
  entries: TimelineEntry[];
  incomeContributions: TimelineIncomeContribution[];
  initialCalendar: LocalCalendar;
  stories?: StoryChapter[];
  user?: TimelineAccountUser | null;
  authError?: boolean;
}) {
  return (
    <StoryCatalogueContext.Provider value={props.stories ?? storyChapters}>
      <TimelineScheduleContent {...props} />
    </StoryCatalogueContext.Provider>
  );
}

function TimelineScheduleContent({
  entries,
  incomeContributions,
  initialCalendar,
  user,
  authError = false,
}: {
  entries: TimelineEntry[];
  incomeContributions: TimelineIncomeContribution[];
  initialCalendar: LocalCalendar;
  user?: TimelineAccountUser | null;
  authError?: boolean;
}) {
  const catalogue = useStoryCatalogue();
  const router = useRouter();
  const [calendar, setCalendar] = useState(initialCalendar);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedIncomeKey, setSelectedIncomeKey] = useState<string | null>(
    null,
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedDayBannerId, setSelectedDayBannerId] = useState<string | null>(
    null,
  );
  const [playerProfile, setPlayerProfile] =
    useState<PlayerForecastProfile | null>(null);
  const [rewardPreferences, setRewardPreferences] = useState<RewardPreferences>(
    createRewardPreferences,
  );
  const [rewardStorageError, setRewardStorageError] = useState(false);
  const [summonSessions, setSummonSessions] = useState<SummonSession[]>([]);
  const [summonStorageWarning, setSummonStorageWarning] = useState<
    string | null
  >(null);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [accountPanelOpen, setAccountPanelOpen] = useState(authError);
  const [localPlannerReady, setLocalPlannerReady] = useState(false);
  const [planDemo, setPlanDemo] = useState<PlanDemo | null>(null);
  const [railTooltip, setRailTooltip] = useState<RailTooltip | null>(null);
  const scheduleRef = useRef<HTMLElement>(null);
  const scrollFrameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const planDemoRunRef = useRef(0);
  const plannerPayload = useMemo(
    () =>
      createPlannerStatePayload({
        profile: playerProfile,
        rewardPreferences,
        summonSessions,
      }),
    [playerProfile, rewardPreferences, summonSessions],
  );
  const plannerSync = usePlannerStateSync({
    userId: user?.id ?? null,
    localReady: localPlannerReady,
    payload: plannerPayload,
    replaceLocal: replaceLocalPlannerState,
  });

  useEffect(() => {
    const localCalendar = readLocalCalendar();
    setCalendar((current) =>
      current.today === localCalendar.today &&
      current.timeZone === localCalendar.timeZone
        ? current
        : localCalendar,
    );
    try {
      setPlayerProfile(loadPlayerForecastProfile(window.localStorage));
      setRewardPreferences(loadRewardPreferences(window.localStorage));
      const loadedSessions = loadSummonSessions(window.localStorage);
      setSummonSessions(loadedSessions.sessions);
      setSummonStorageWarning(loadedSessions.warnings[0] ?? null);
    } catch {
      setRewardStorageError(true);
    } finally {
      setLocalPlannerReady(true);
    }
  }, []);

  useEffect(() => {
    if (!planDemo) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const selectTimer = window.setTimeout(
      () => {
        setSelectedDayBannerId(null);
        setSelectedDay(planDemo.day);
      },
      reduceMotion ? 400 : 850,
    );
    const clearTimer = window.setTimeout(
      () => setPlanDemo(null),
      reduceMotion ? 700 : 1_350,
    );

    return () => {
      window.clearTimeout(selectTimer);
      window.clearTimeout(clearTimer);
    };
  }, [planDemo]);

  useEffect(() => {
    if (
      selectedKey !== null ||
      selectedIncomeKey !== null ||
      selectedDay !== null ||
      profilePanelOpen
    ) {
      setAccountPanelOpen(false);
    }
  }, [profilePanelOpen, selectedDay, selectedIncomeKey, selectedKey]);

  useLayoutEffect(() => {
    const scrollFrame = scrollFrameRef.current;
    const ledger = ledgerRef.current;
    if (!scrollFrame || !ledger) return;

    const categories = [
      ...ledger.querySelectorAll<HTMLElement>(":scope > .timeline-category"),
    ];
    if (categories.length !== 3) return;

    const updateCategoryRows = () => {
      const [eventRow, summonRow, incomeRow] = categories;
      scrollFrame.style.setProperty(
        "--timeline-event-track-height",
        `${eventRow?.getBoundingClientRect().height ?? 0}px`,
      );
      scrollFrame.style.setProperty(
        "--timeline-summon-track-height",
        `${summonRow?.getBoundingClientRect().height ?? 0}px`,
      );
      scrollFrame.style.setProperty(
        "--timeline-income-track-height",
        `${incomeRow?.getBoundingClientRect().height ?? 0}px`,
      );
    };

    updateCategoryRows();
    const resizeObserver = new ResizeObserver(updateCategoryRows);
    for (const category of categories) resizeObserver.observe(category);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const finePointer = window.matchMedia("(any-pointer: fine)");

    const handleWheel = (event: WheelEvent) => {
      if (!finePointer.matches) return;

      const delta = horizontalWheelDelta({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        isZoomGesture: event.ctrlKey,
        scrollLeft: scroll.scrollLeft,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
      });

      if (delta === 0) return;

      event.preventDefault();
      scroll.scrollLeft += delta;
    };

    scroll.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      scroll.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const view = useMemo(() => {
    const endDay = scheduleEndDay(calendar.today);
    const days = calendarDays(calendar.today, endDay);
    const scheduleEntries = entries.filter(
      (entry) => entry.category !== "INCOME_SOURCE",
    );
    const layouts = layoutSchedule(scheduleEntries as LedgerEntry[], {
      startDay: calendar.today,
      endDay,
      timeZone: calendar.timeZone,
    });
    const incomeCells = buildIncomeLedger(
      days,
      incomeContributions,
      playerProfile,
      calendar.timeZone,
      rewardPreferences,
      catalogue,
      summonSessions,
    );

    return { days, layouts, incomeCells };
  }, [
    catalogue,
    calendar,
    entries,
    incomeContributions,
    playerProfile,
    rewardPreferences,
    summonSessions,
  ]);

  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        weekday: "short",
        timeZone: "UTC",
      }),
    [],
  );

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.key === selectedKey) ?? null,
    [entries, selectedKey],
  );
  const selectedIncomeCell = selectedIncomeKey
    ? (view.incomeCells.get(selectedIncomeKey) ?? null)
    : null;

  function saveProfile(profile: PlayerForecastProfile) {
    setPlayerProfile(profile);
    try {
      savePlayerForecastProfile(window.localStorage, profile);
      setRewardStorageError(false);
    } catch {
      setRewardStorageError(true);
    }
    setProfilePanelOpen(false);
    router.refresh();
  }

  function replaceLocalPlannerState(payload: typeof plannerPayload) {
    setPlayerProfile(payload.profile);
    setRewardPreferences(payload.rewardPreferences);
    setSummonSessions(payload.summonSessions);
    setSummonStorageWarning(null);
    try {
      if (payload.profile) {
        savePlayerForecastProfile(window.localStorage, payload.profile);
      } else {
        clearPlayerForecastProfile(window.localStorage);
      }
      saveRewardPreferences(window.localStorage, payload.rewardPreferences);
      saveSummonSessions(window.localStorage, payload.summonSessions);
      setRewardStorageError(false);
    } catch {
      setRewardStorageError(true);
    }
  }

  function saveRewardInclusion(rewardId: string, included: boolean | null) {
    const next = setRewardInclusion(rewardPreferences, rewardId, included);
    setRewardPreferences(next);
    try {
      saveRewardPreferences(window.localStorage, next);
      setRewardStorageError(false);
    } catch {
      setRewardStorageError(true);
    }
  }

  function persistSummonSessions(next: SummonSession[]) {
    setSummonSessions(next);
    try {
      saveSummonSessions(window.localStorage, next);
      setSummonStorageWarning(null);
      setRewardStorageError(false);
    } catch {
      setRewardStorageError(true);
    }
  }

  function addSummonSession(session: SummonSession) {
    persistSummonSessions([...summonSessions, session]);
  }

  function replaceSummonSession(session: SummonSession) {
    persistSummonSessions(
      summonSessions.map((current) =>
        current.id === session.id ? session : current,
      ),
    );
  }

  function copySummonSession(sessionId: string) {
    persistSummonSessions(duplicateSummonSession(summonSessions, sessionId));
  }

  function changeSummonSessionDay(sessionId: string, day: string) {
    persistSummonSessions(moveSummonSession(summonSessions, sessionId, day));
  }

  function removeSummonSession(sessionId: string) {
    persistSummonSessions(deleteSummonSession(summonSessions, sessionId));
  }

  function changeSummonSessionStatus(
    sessionId: string,
    status: SummonSessionStatus,
  ) {
    persistSummonSessions(
      setSummonSessionStatus(summonSessions, sessionId, status),
    );
  }

  function closeSelectedDay() {
    const day = selectedDay;
    setSelectedDay(null);
    setSelectedDayBannerId(null);
    if (day) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const target =
            document.getElementById(`timeline-day-${day}`) ??
            document.querySelector<HTMLElement>(".timeline-day");
          target?.focus();
        });
      });
    }
  }

  function returnToToday() {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    scheduleRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    scrollRef.current?.scrollTo({
      behavior: reduceMotion ? "auto" : "smooth",
      top: 0,
      left: 0,
    });
  }

  function demonstrateDaySelection() {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const index = visibleDayIndex({
      scrollLeft: scroll.scrollLeft,
      viewportWidth: scroll.clientWidth,
      dayWidth: timelineLayout.dayWidth,
      dayCount: view.days.length,
    });
    const day = view.days[index];
    if (!day) return;

    planDemoRunRef.current += 1;
    setProfilePanelOpen(false);
    setSelectedKey(null);
    setSelectedIncomeKey(null);
    setSelectedDayBannerId(null);
    setSelectedDay(null);
    setPlanDemo({ day, runId: planDemoRunRef.current });
  }

  function showRailTooltip(
    entry: TimelineEntry,
    target: HTMLButtonElement,
    pointerX?: number,
    pointerY?: number,
  ) {
    const bounds = target.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.getBoundingClientRect().left ?? 0;
    const visibleLeft = Math.max(bounds.left, scrollLeft);
    const visibleRight = Math.min(bounds.right, window.innerWidth);
    const position = positionViewportTooltip({
      anchorX:
        pointerX ??
        (visibleRight > visibleLeft
          ? (visibleLeft + visibleRight) / 2
          : bounds.left + bounds.width / 2),
      anchorY: pointerY ?? bounds.top + 24,
      safeTop:
        document
          .querySelector<HTMLElement>(".timeline-app-bar")
          ?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });

    setRailTooltip({
      key: entry.key,
      name: entry.name,
      ...position,
    });
  }

  function hideRailTooltip(key: string) {
    setRailTooltip((current) => (current?.key === key ? null : current));
  }

  const timelineStyle = {
    "--day-count": view.days.length,
    "--day-width": `${timelineLayout.dayWidth}px`,
    "--timeline-category-label-width": `${timelineLayout.categoryLabelWidth}px`,
    "--timeline-min-schedule-category-height": `${timelineLayout.minimumScheduleCategoryHeight}px`,
    "--timeline-income-resource-count": timelineLayout.incomeResourceCount,
    "--timeline-sticky-label-inset": `${timelineLayout.stickyLabelInset}px`,
  } as CSSProperties;
  const gridStyle = {
    width: `${view.days.length * timelineLayout.dayWidth}px`,
  } as CSSProperties;
  const selectedDayIndex = selectedDay ? view.days.indexOf(selectedDay) : -1;
  const selectedDayBanners = selectedDay
    ? entries.flatMap((entry) => {
        if (entry.kind !== "BANNER") return [];
        const starts = calendarDayKey(
          entry.startsAt,
          entry.startsAtPrecision,
          calendar.timeZone,
        );
        const ends = entry.endsAt
          ? calendarDayKey(
              entry.endsAt,
              entry.endsAtPrecision ?? "EXACT",
              calendar.timeZone,
            )
          : starts;
        return selectedDay >= starts && selectedDay <= ends
          ? [{ id: entry.id, name: entry.name }]
          : [];
      })
    : [];
  const selectedDaySessions = selectedDay
    ? summonSessions.filter((session) => session.day === selectedDay)
    : [];
  const selectedDayBalances = selectedDay
    ? forecastBalancesOnDay(
        view.incomeCells,
        playerProfile,
        view.days[0] ?? calendar.today,
        selectedDay,
      )
    : null;
  const findAffordableDay = selectedDay
    ? (spending: SummonPlanSpending, excludedSessionId?: string) =>
        findEarliestAffordableSummonDay(
          view.incomeCells,
          playerProfile,
          view.days[0] ?? calendar.today,
          view.days,
          selectedDay,
          spending,
          excludedSessionId
            ? summonSessions.find((session) => session.id === excludedSessionId)
            : undefined,
        )
    : undefined;
  const hasDetailsSelection = Boolean(
    selectedEntry !== null ||
    selectedIncomeCell !== null ||
    selectedDay !== null ||
    profilePanelOpen ||
    accountPanelOpen,
  );
  const detailsSelectionKey = selectedDay
    ? `day:${selectedDay}`
    : profilePanelOpen
      ? "profile"
      : accountPanelOpen
        ? "account"
        : selectedIncomeCell
          ? `income:${selectedIncomeCell.key}`
          : selectedEntry
            ? `entry:${selectedEntry.key}`
            : "placeholder";
  const detailsHeadingId = selectedDay
    ? "timeline-day-heading"
    : profilePanelOpen
      ? "timeline-profile-heading"
      : accountPanelOpen
        ? "timeline-account-heading"
        : "timeline-details-heading";

  function closeActiveDetails() {
    if (selectedDay) {
      closeSelectedDay();
      return;
    }
    if (accountPanelOpen) {
      setAccountPanelOpen(false);
      return;
    }
    setProfilePanelOpen(false);
    setSelectedIncomeKey(null);
    setSelectedKey(null);
  }

  return (
    <section
      ref={scheduleRef}
      className="timeline-shell"
      aria-label="Two-year schedule"
      data-sync-status={plannerSync.status}
      style={timelineStyle}
    >
      <h2 className="sr-only">Two-year schedule</h2>
      <div className="timeline-toolbar">
        <div className="timeline-toolbar-actions">
          <div className="timeline-legend" aria-label="Schedule status legend">
            {Object.entries(statusNames).map(([status, name]) => (
              <span key={status} data-status={status}>
                <i aria-hidden="true" />
                {name}
              </span>
            ))}
          </div>

          <button
            type="button"
            className="timeline-tonal-button timeline-toolbar-action"
            aria-label="Show how to select a summon planning date"
            onClick={demonstrateDaySelection}
          >
            <span
              className="timeline-toolbar-action-label"
              data-short-label="Plan"
              aria-hidden="true"
            >
              <span>Plan summons</span>
            </span>
          </button>

          <button
            type="button"
            className="timeline-tonal-button timeline-toolbar-action"
            aria-label="Balances"
            data-attention={playerProfile ? undefined : "true"}
            onClick={() => {
              setPlanDemo(null);
              setSelectedKey(null);
              setSelectedIncomeKey(null);
              setSelectedDay(null);
              setProfilePanelOpen(true);
            }}
          >
            <span
              className="timeline-toolbar-action-label"
              data-short-label="Balance"
              aria-hidden="true"
            >
              <span>Balances</span>
            </span>
          </button>

          <button
            type="button"
            className="timeline-tonal-button timeline-toolbar-action"
            aria-label="Today"
            onClick={() => {
              setPlanDemo(null);
              returnToToday();
            }}
          >
            <span
              className="timeline-toolbar-action-label"
              data-short-label="Today"
              aria-hidden="true"
            >
              <span>Today</span>
            </span>
          </button>

          <TimelineAccountMenu
            user={user ?? null}
            onOpen={() => {
              setPlanDemo(null);
              setSelectedKey(null);
              setSelectedIncomeKey(null);
              setSelectedDay(null);
              setProfilePanelOpen(false);
              setAccountPanelOpen(true);
            }}
          />
        </div>
      </div>

      {rewardStorageError ? (
        <p className="timeline-preference-notice" role="status">
          Your browser could not save forecast settings. Changes apply until you
          reload this page.
        </p>
      ) : null}
      {user && plannerSync.status === "LOCAL_ONLY" ? (
        <p className="timeline-preference-notice" role="status">
          Cloud sync is unavailable. Changes are still saved in this browser.
        </p>
      ) : null}
      {user &&
      plannerSync.status === "CONFLICT" &&
      !plannerSync.conflict?.open ? (
        <div className="timeline-preference-notice" role="status">
          <span>Cloud sync is paused until you choose which copy to keep.</span>
          <button type="button" onClick={plannerSync.openConflict}>
            Choose a copy
          </button>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="timeline-preference-notice" role="status">
          No events or summoning campaigns are available for this period.
          Balances and summon planning are still available.
        </p>
      ) : null}
      {summonStorageWarning ? (
        <p className="timeline-preference-notice" role="status">
          {summonStorageWarning} Other saved sessions remain available.
        </p>
      ) : null}
      <div
        className="timeline-workspace"
        data-has-selection={
          selectedEntry ||
          selectedIncomeCell ||
          selectedDay ||
          profilePanelOpen ||
          accountPanelOpen
            ? "true"
            : "false"
        }
      >
        <div ref={scrollFrameRef} className="timeline-scroll-frame">
          <div
            ref={scrollRef}
            className="timeline-scroll"
            role="region"
            aria-label="Two-year schedule. Scroll horizontally through dates."
            tabIndex={0}
            onScroll={() => {
              setRailTooltip(null);
            }}
          >
            <div ref={ledgerRef} className="timeline-ledger" style={gridStyle}>
              {selectedDayIndex >= 0 ? (
                <span
                  className="timeline-selected-day-column"
                  style={{
                    left: selectedDayIndex * timelineLayout.dayWidth,
                    width: timelineLayout.dayWidth,
                  }}
                  aria-hidden="true"
                />
              ) : null}
              <header className="timeline-date-axis">
                <div
                  className="timeline-date-track"
                  aria-label="Calendar dates"
                >
                  {view.days.map((day) => {
                    const label = dateLabel(day, formatter);
                    const isMonthStart = day.endsWith("-01");
                    const daySessions = summonSessions.filter(
                      (session) => session.day === day,
                    );
                    const hasSessions = daySessions.length > 0;
                    const hasPlanned = daySessions.some(
                      (session) => session.status === "PLANNED",
                    );
                    const hasSpent = daySessions.some(
                      (session) => session.status === "SPENT",
                    );
                    const sessionStatus =
                      hasPlanned && hasSpent
                        ? "MIXED"
                        : hasSpent
                          ? "SPENT"
                          : "PLANNED";
                    const sessionLabel = hasSessions
                      ? hasPlanned && hasSpent
                        ? " Has planned and spent summon sessions."
                        : hasSpent
                          ? " Has a spent summon session."
                          : " Has a planned summon session."
                      : "";
                    return (
                      <button
                        key={day}
                        id={`timeline-day-${day}`}
                        type="button"
                        className="timeline-day"
                        data-month-start={isMonthStart ? "true" : "false"}
                        data-selected={selectedDay === day ? "true" : undefined}
                        data-has-sessions={hasSessions ? "true" : undefined}
                        title={`Plan summons for ${label.weekday}, ${label.month} ${label.day}`}
                        aria-label={`${label.weekday}, ${label.month} ${label.day}.${sessionLabel} Select this date to plan summons.`}
                        aria-pressed={selectedDay === day}
                        onClick={() => {
                          setPlanDemo(null);
                          setProfilePanelOpen(false);
                          setSelectedKey(null);
                          setSelectedIncomeKey(null);
                          setSelectedDayBannerId(null);
                          setSelectedDay(day);
                        }}
                      >
                        <time dateTime={day}>
                          <span>{label.month}</span>
                          <strong>{label.day}</strong>
                          <small>{label.weekday}</small>
                        </time>
                        {planDemo?.day === day ? (
                          <TimelineDayClickDemo key={planDemo.runId} />
                        ) : null}
                        {hasSessions ? (
                          <i
                            className="timeline-day-session-marker"
                            data-status={sessionStatus}
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </header>

              {view.layouts.map((layout) =>
                layout.category === "INCOME_SOURCE" ? (
                  <TimelineIncomeLedger
                    key={layout.category}
                    days={view.days}
                    cells={view.incomeCells}
                    selectedKey={selectedIncomeKey}
                    onSelect={(cell) => {
                      setPlanDemo(null);
                      setProfilePanelOpen(false);
                      setSelectedKey(null);
                      setSelectedDay(null);
                      setSelectedIncomeKey(cell.key);
                    }}
                  />
                ) : (
                  <CategoryRow
                    key={layout.category}
                    layout={layout}
                    selectedKey={selectedKey}
                    timeZone={calendar.timeZone}
                    onSelect={(entry) => {
                      setPlanDemo(null);
                      setProfilePanelOpen(false);
                      setSelectedIncomeKey(null);
                      setSelectedDay(null);
                      setSelectedKey(entry.key);
                    }}
                    onShowTooltip={showRailTooltip}
                    onHideTooltip={hideRailTooltip}
                  />
                ),
              )}
            </div>
          </div>

          <div className="timeline-frozen-date" aria-hidden="true">
            Date
          </div>
          <div className="timeline-frozen-categories" aria-hidden="true">
            <div className="timeline-frozen-category-track">
              {view.layouts.map(({ category }) => (
                <div
                  key={category}
                  className="timeline-category-label"
                  data-category={category}
                >
                  {category === "INCOME_SOURCE" ? (
                    <div className="timeline-income-labels">
                      {forecastResourceTypes.map((itemType) => (
                        <span key={itemType} data-resource={itemType}>
                          <Image
                            className="timeline-income-resource-icon"
                            src={incomeResourceIcons[itemType]}
                            alt=""
                            width={timelineLayout.incomeResourceIconSize}
                            height={timelineLayout.incomeResourceIconSize}
                            loading="eager"
                          />
                          <b>{incomeResourceLabels[itemType]}</b>
                        </span>
                      ))}
                    </div>
                  ) : (
                    categoryNames[category]
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <TimelineDetailsLayer
          active={hasDetailsSelection}
          labelledBy={detailsHeadingId}
          selectionKey={detailsSelectionKey}
          returnFocusId={
            selectedDay
              ? `timeline-day-${selectedDay}`
              : accountPanelOpen
                ? "timeline-account-button"
                : undefined
          }
          onClose={closeActiveDetails}
        >
          {selectedDay && selectedDayBalances ? (
            <TimelineDayDetails
              key={selectedDay}
              day={selectedDay}
              banners={selectedDayBanners}
              balances={selectedDayBalances}
              sessions={selectedDaySessions}
              initialBannerId={selectedDayBannerId}
              onSave={addSummonSession}
              onUpdate={replaceSummonSession}
              onDuplicate={copySummonSession}
              onMove={changeSummonSessionDay}
              onDelete={removeSummonSession}
              onStatusChange={changeSummonSessionStatus}
              findAffordableDay={findAffordableDay}
              scheduleStartDay={view.days[0]}
              scheduleEndDay={view.days.at(-1)}
              timeZone={calendar.timeZone}
              onClose={closeSelectedDay}
            />
          ) : profilePanelOpen ? (
            <TimelineProfileDetails
              profile={playerProfile}
              today={calendar.today}
              onSaveProfile={saveProfile}
              onClose={() => setProfilePanelOpen(false)}
            />
          ) : accountPanelOpen ? (
            <TimelineAccountDetails
              signedIn={Boolean(user)}
              authError={authError}
              onClose={() => setAccountPanelOpen(false)}
            />
          ) : selectedIncomeCell ? (
            <TimelineIncomeDetails
              cell={selectedIncomeCell}
              rewardPreferences={rewardPreferences}
              profile={playerProfile}
              onSetRewardInclusion={saveRewardInclusion}
              onOpenProfile={() => {
                setSelectedIncomeKey(null);
                setProfilePanelOpen(true);
              }}
              onClose={() => setSelectedIncomeKey(null)}
            />
          ) : selectedEntry ? (
            <TimelineEntryDetails
              entry={selectedEntry}
              profile={playerProfile}
              timeZone={calendar.timeZone}
              rewardPreferences={rewardPreferences}
              onSetRewardInclusion={saveRewardInclusion}
              onPlanSummons={
                selectedEntry.kind === "BANNER"
                  ? () => {
                      const starts = calendarDayKey(
                        selectedEntry.startsAt,
                        selectedEntry.startsAtPrecision,
                        calendar.timeZone,
                      );
                      const ends = selectedEntry.endsAt
                        ? calendarDayKey(
                            selectedEntry.endsAt,
                            selectedEntry.endsAtPrecision ?? "EXACT",
                            calendar.timeZone,
                          )
                        : starts;
                      const preferredDay =
                        calendar.today >= starts && calendar.today <= ends
                          ? calendar.today
                          : starts;
                      const firstDay = view.days[0] ?? preferredDay;
                      const lastDay = view.days.at(-1) ?? preferredDay;
                      const day =
                        preferredDay < firstDay
                          ? firstDay
                          : preferredDay > lastDay
                            ? lastDay
                            : preferredDay;
                      setSelectedDayBannerId(selectedEntry.id);
                      setSelectedKey(null);
                      setSelectedDay(day);
                    }
                  : undefined
              }
              onClose={() => setSelectedKey(null)}
            />
          ) : (
            <TimelineDetailsPlaceholder
              profile={playerProfile}
              today={calendar.today}
              onSaveProfile={saveProfile}
              onOpenProfile={() => setProfilePanelOpen(true)}
            />
          )}
        </TimelineDetailsLayer>
      </div>

      {railTooltip
        ? createPortal(
            <div
              className="timeline-rail-tooltip"
              data-placement={railTooltip.placement}
              style={{ left: railTooltip.x, top: railTooltip.y }}
              aria-hidden="true"
            >
              {railTooltip.name}
            </div>,
            document.body,
          )
        : null}
      {plannerSync.conflict?.open ? (
        <PlannerSyncConflictDialog
          localPayload={plannerPayload}
          cloud={plannerSync.conflict.cloud}
          onKeepDevice={() => void plannerSync.keepDeviceCopy()}
          onKeepCloud={() => void plannerSync.keepCloudCopy()}
          onClose={plannerSync.dismissConflict}
        />
      ) : null}
    </section>
  );
}
