"use client";

import Image from "next/image";
import {
  useEffect,
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
import {
  buildIncomeLedger,
  incomeResourceIcons,
  incomeResourceLabels,
} from "~/app/timeline/_lib/income-ledger";
import {
  forecastResourceTypes,
  loadPlayerForecastProfile,
  savePlayerForecastProfile,
  type PlayerForecastProfile,
} from "~/app/timeline/_lib/player-forecast";
import {
  calendarDayKey,
  calendarDays,
  laneSharePercent,
  layoutSchedule,
  type ScheduleCategoryLayout,
  type ScheduleInterval,
} from "~/app/timeline/_lib/schedule-layout";
import {
  minimumIncomeCategoryHeight,
  minimumCategoryStackHeight,
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

export function TimelineSchedule({
  entries,
  incomeContributions,
  initialCalendar,
}: {
  entries: TimelineEntry[];
  incomeContributions: TimelineIncomeContribution[];
  initialCalendar: LocalCalendar;
}) {
  const [calendar, setCalendar] = useState(initialCalendar);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedIncomeKey, setSelectedIncomeKey] = useState<string | null>(
    null,
  );
  const [playerProfile, setPlayerProfile] =
    useState<PlayerForecastProfile | null>(null);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [railTooltip, setRailTooltip] = useState<RailTooltip | null>(null);
  const scheduleRef = useRef<HTMLElement>(null);
  const scrollFrameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  const dateAxisRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const localCalendar = readLocalCalendar();
    setCalendar((current) =>
      current.today === localCalendar.today &&
      current.timeZone === localCalendar.timeZone
        ? current
        : localCalendar,
    );
    setPlayerProfile(loadPlayerForecastProfile(window.localStorage));
  }, []);

  useEffect(() => {
    const scrollFrame = scrollFrameRef.current;
    const ledger = ledgerRef.current;
    const dateAxis = dateAxisRef.current;

    if (!scrollFrame || !ledger || !dateAxis) return;

    const updateCategoryTrackHeight = () => {
      const categoryTrackHeight =
        ledger.getBoundingClientRect().height -
        dateAxis.getBoundingClientRect().height;

      scrollFrame.style.setProperty(
        "--timeline-category-track-height",
        `${Math.max(0, categoryTrackHeight)}px`,
      );
    };

    updateCategoryTrackHeight();

    const resizeObserver = new ResizeObserver(updateCategoryTrackHeight);
    resizeObserver.observe(ledger);
    resizeObserver.observe(dateAxis);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const finePointer = window.matchMedia("(any-pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame: number | null = null;
    let targetScrollLeft: number | null = null;

    const stopAnimation = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      targetScrollLeft = null;
    };

    const animateScroll = () => {
      if (targetScrollLeft === null) {
        animationFrame = null;
        return;
      }

      const remainingDistance = targetScrollLeft - scroll.scrollLeft;
      if (Math.abs(remainingDistance) <= timelineLayout.wheelStopThreshold) {
        scroll.scrollLeft = targetScrollLeft;
        animationFrame = null;
        targetScrollLeft = null;
        return;
      }

      scroll.scrollLeft +=
        remainingDistance * timelineLayout.wheelSmoothingFactor;
      animationFrame = requestAnimationFrame(animateScroll);
    };

    const handleWheel = (event: WheelEvent) => {
      if (!finePointer.matches) return;

      const delta = horizontalWheelDelta({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        isZoomGesture: event.ctrlKey,
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
        scrollWidth: scroll.scrollWidth,
        scrollHeight: scroll.scrollHeight,
        clientWidth: scroll.clientWidth,
        clientHeight: scroll.clientHeight,
      });

      if (delta === 0) {
        stopAnimation();
        return;
      }

      event.preventDefault();
      const maximumScrollLeft = Math.max(
        0,
        scroll.scrollWidth - scroll.clientWidth,
      );
      targetScrollLeft = Math.min(
        maximumScrollLeft,
        Math.max(0, (targetScrollLeft ?? scroll.scrollLeft) + delta),
      );

      if (reducedMotion.matches) {
        scroll.scrollLeft = targetScrollLeft;
        targetScrollLeft = null;
        return;
      }

      animationFrame ??= requestAnimationFrame(animateScroll);
    };

    scroll.addEventListener("wheel", handleWheel, { passive: false });
    scroll.addEventListener("pointerdown", stopAnimation);

    return () => {
      stopAnimation();
      scroll.removeEventListener("wheel", handleWheel);
      scroll.removeEventListener("pointerdown", stopAnimation);
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
    );

    return { days, layouts, incomeCells };
  }, [calendar, entries, incomeContributions, playerProfile]);

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
    savePlayerForecastProfile(window.localStorage, profile);
    setPlayerProfile(profile);
    setProfilePanelOpen(false);
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

  if (entries.length === 0) {
    return (
      <section className="timeline-empty">
        <p>No schedule entries are available for the next two years.</p>
      </section>
    );
  }

  const timelineStyle = {
    "--day-count": view.days.length,
    "--day-width": `${timelineLayout.dayWidth}px`,
    "--timeline-category-label-width": `${timelineLayout.categoryLabelWidth}px`,
    "--timeline-min-schedule-category-height": `${timelineLayout.minimumScheduleCategoryHeight}px`,
    "--timeline-min-income-category-height": `${minimumIncomeCategoryHeight}px`,
    "--timeline-min-income-row-height": `${timelineLayout.minimumIncomeResourceRowHeight}px`,
    "--timeline-income-resource-count": timelineLayout.incomeResourceCount,
    "--timeline-income-icon-size": `${timelineLayout.incomeResourceIconSize}px`,
    "--timeline-min-category-stack-height": `${minimumCategoryStackHeight}px`,
    "--timeline-sticky-label-inset": `${timelineLayout.stickyLabelInset}px`,
  } as CSSProperties;
  const gridStyle = {
    width: `${view.days.length * timelineLayout.dayWidth}px`,
  } as CSSProperties;

  return (
    <section
      ref={scheduleRef}
      className="timeline-shell"
      aria-label="Two-year schedule"
      style={timelineStyle}
    >
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
            className="timeline-tonal-button"
            data-attention={playerProfile ? undefined : "true"}
            onClick={() => {
              setSelectedKey(null);
              setSelectedIncomeKey(null);
              setProfilePanelOpen(true);
            }}
          >
            Balances
          </button>

          <button
            type="button"
            className="timeline-tonal-button"
            onClick={returnToToday}
          >
            Today
          </button>
        </div>
      </div>

      <div
        className="timeline-workspace"
        data-has-selection={
          selectedEntry || selectedIncomeCell || profilePanelOpen
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
            onScroll={(event) => {
              event.currentTarget.parentElement?.style.setProperty(
                "--timeline-scroll-y",
                `${-event.currentTarget.scrollTop}px`,
              );
              setRailTooltip(null);
            }}
          >
            <div ref={ledgerRef} className="timeline-ledger" style={gridStyle}>
              <header ref={dateAxisRef} className="timeline-date-axis">
                <div
                  className="timeline-date-track"
                  aria-label="Calendar dates"
                >
                  {view.days.map((day) => {
                    const label = dateLabel(day, formatter);
                    const isMonthStart = day.endsWith("-01");
                    return (
                      <time
                        key={day}
                        id={`timeline-day-${day}`}
                        dateTime={day}
                        className="timeline-day"
                        data-month-start={isMonthStart ? "true" : "false"}
                        title={`${label.weekday}, ${label.month} ${label.day}`}
                      >
                        <span>{label.month}</span>
                        <strong>{label.day}</strong>
                        <small>{label.weekday}</small>
                      </time>
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
                      setProfilePanelOpen(false);
                      setSelectedKey(null);
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
                      setProfilePanelOpen(false);
                      setSelectedIncomeKey(null);
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

        {profilePanelOpen ? (
          <TimelineProfileDetails
            profile={playerProfile}
            today={calendar.today}
            onSaveProfile={saveProfile}
            onClose={() => setProfilePanelOpen(false)}
          />
        ) : selectedIncomeCell ? (
          <TimelineIncomeDetails
            cell={selectedIncomeCell}
            profile={playerProfile}
            onOpenProfile={() => {
              setSelectedIncomeKey(null);
              setProfilePanelOpen(true);
            }}
            onClose={() => setSelectedIncomeKey(null)}
          />
        ) : selectedEntry ? (
          <TimelineEntryDetails
            entry={selectedEntry}
            timeZone={calendar.timeZone}
            onClose={() => setSelectedKey(null)}
          />
        ) : (
          <TimelineDetailsPlaceholder
            profile={playerProfile}
            today={calendar.today}
            onSaveProfile={saveProfile}
          />
        )}
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
    </section>
  );
}
