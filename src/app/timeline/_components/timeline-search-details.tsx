"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api } from "~/trpc/react";
import { calendarDayKey } from "../_lib/schedule-layout";
import {
  timelineSearchLimits,
  servantMatchesSearch,
  type TimelineSearchEntry,
} from "~/shared/timeline-search";
import { ServantThumbnail } from "./servant-thumbnail";
import { timelineLayout } from "../_lib/timeline-layout-config";
import { formatSearchAvailability } from "../_lib/schedule-date";

const statuses = {
  OFFICIAL: "Official",
  CURATED: "Curated",
  PROJECTED: "Projected",
};

export type TimelineSearchState = { query: string; expanded: string[] };

function SearchServants({
  servants,
  matching = false,
}: {
  servants: TimelineSearchEntry["servants"];
  matching?: boolean;
}) {
  return (
    <span className="timeline-search-servants">
      {servants.map((servant) => (
        <span
          key={servant.id}
          className="timeline-search-servant"
          data-matching={matching ? "true" : undefined}
        >
          <ServantThumbnail
            url={servant.thumbnailUrl}
            size={timelineLayout.servantSearchThumbnailSize}
          />
          <span>
            {matching ? (
              <strong>{servant.name}</strong>
            ) : (
              <span>{servant.name}</span>
            )}
            <small>{servant.className}</small>
          </span>
        </span>
      ))}
    </span>
  );
}

export function TimelineSearchResult({
  entry,
  query,
  timeZone,
  disabled,
  opening = false,
  failed = false,
  now,
  expanded,
  onExpandedChange,
  onSelect,
}: {
  entry: TimelineSearchEntry;
  query: string;
  timeZone: string;
  disabled: boolean;
  opening?: boolean;
  failed?: boolean;
  now: Date;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: () => void;
}) {
  const matching = entry.servants.filter((servant) =>
    servantMatchesSearch(servant, query),
  );
  const matchingIds = new Set(matching.map((servant) => servant.id));
  const others = entry.servants.filter(
    (servant) => !matchingIds.has(servant.id),
  );
  const preview = matching.length
    ? matching
    : others.slice(0, timelineLayout.servantSearchPreviewCount);
  const remaining = matching.length ? others : others.slice(preview.length);
  return (
    <li className="timeline-search-result-row">
      <button
        type="button"
        className="timeline-search-result"
        disabled={disabled}
        data-opening={opening ? "true" : undefined}
        aria-busy={opening || undefined}
        onClick={onSelect}
      >
        <strong className="timeline-search-result-title">{entry.name}</strong>
        <span className="timeline-search-availability">
          {formatSearchAvailability(entry, now, timeZone)}
        </span>
        <span className="timeline-search-result-meta">
          {calendarDayKey(entry.startsAt, entry.startsAtPrecision, timeZone)}
          {entry.endsAt
            ? ` – ${calendarDayKey(entry.endsAt, entry.endsAtPrecision ?? "EXACT", timeZone)}`
            : ""}
          <span
            className="timeline-search-result-status"
            data-status={entry.status}
          >
            {statuses[entry.status]}
          </span>
        </span>
        {preview.length ? (
          <SearchServants servants={preview} matching={matching.length > 0} />
        ) : null}
      </button>
      {opening ? (
        <p className="timeline-search-row-message" role="status">
          Opening {entry.kind === "BANNER" ? "campaign" : "event"}…
        </p>
      ) : null}
      {failed ? (
        <p className="timeline-search-row-message" role="alert">
          Could not open this result. Select it again to retry.
        </p>
      ) : null}
      {remaining.length ? (
        <details
          className="timeline-search-other-servants"
          open={expanded}
          onToggle={(event) => {
            if (event.currentTarget.open !== expanded)
              onExpandedChange(event.currentTarget.open);
          }}
        >
          <summary>
            {expanded ? "Hide" : "Show"} {remaining.length} other{" "}
            {remaining.length === 1 ? "servant" : "servants"}
          </summary>
          {expanded ? <SearchServants servants={remaining} /> : null}
        </details>
      ) : null}
    </li>
  );
}

export function TimelineSearchDetails({
  scheduleStartDay,
  timeZone,
  onSelect,
  onClose,
  state,
  onStateChange,
  scrollPosition,
}: {
  scheduleStartDay: string;
  timeZone: string;
  onSelect: (entry: TimelineSearchEntry) => Promise<void>;
  onClose: () => void;
  state: TimelineSearchState;
  onStateChange: Dispatch<SetStateAction<TimelineSearchState>>;
  scrollPosition: RefObject<number>;
}) {
  const query = state.query;
  const [debounced, setDebounced] = useState(query.trim());
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date()),
      timelineSearchLimits.availabilityRefreshMs,
    );
    return () => window.clearInterval(timer);
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  useEffect(() => {
    // Run after the shared details layer focuses its close button.
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() =>
        inputRef.current?.focus({ preventScroll: true }),
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebounced(query.trim()),
      timelineSearchLimits.debounceMs,
    );
    return () => window.clearTimeout(timer);
  }, [query]);
  const enabled =
    debounced.length >= timelineSearchLimits.minimumQueryCharacters;
  const search = api.timeline.search.useQuery(
    { scheduleStartDay, query: debounced },
    { enabled, refetchOnWindowFocus: false },
  );
  const current = query.trim() === debounced;
  useLayoutEffect(() => {
    if (restoredScroll.current || !current || (enabled && !search.data)) return;
    if (panelRef.current) panelRef.current.scrollTop = scrollPosition.current;
    restoredScroll.current = true;
  }, [current, enabled, search.data, scrollPosition]);
  async function select(entry: TimelineSearchEntry) {
    if (selecting) return;
    setSelecting(entry.key);
    setSelectionError(null);
    try {
      await onSelect(entry);
    } catch {
      setSelectionError(entry.key);
    } finally {
      setSelecting(null);
    }
  }
  return (
    <aside
      className="timeline-details timeline-search-details"
      data-empty="false"
      aria-label="Search timeline"
    >
      <div className="timeline-search-controls">
        <div className="timeline-details-header">
          <h3 id="timeline-search-heading">Search</h3>
          <button
            type="button"
            className="timeline-close-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <label
          className="timeline-search-field"
          htmlFor="timeline-search-input"
        >
          <span>Servant, banner or event name</span>
          <input
            ref={inputRef}
            id="timeline-search-input"
            type="search"
            value={query}
            maxLength={timelineSearchLimits.maximumQueryCharacters}
            autoComplete="off"
            onChange={(event) => {
              scrollPosition.current = 0;
              setSelectionError(null);
              onStateChange({ query: event.target.value, expanded: [] });
            }}
            aria-describedby="timeline-search-status"
          />
        </label>
        <p
          id="timeline-search-status"
          className="timeline-search-status"
          role="status"
        >
          {!enabled ||
          query.trim().length < timelineSearchLimits.minimumQueryCharacters
            ? "Enter at least two characters."
            : !current
              ? "Searching…"
              : search.isError
                ? search.data
                  ? "Results could not refresh. Showing the last results."
                  : "Search could not load. Try again."
                : search.isFetching
                  ? search.data
                    ? "Updating results…"
                    : "Searching…"
                  : search.data?.results.length
                    ? `${search.data.results.length} results${search.data.hasMore ? ". Refine your search to see more." : "."}`
                    : "No matching banners or events. Try a servant name or a shorter title."}
        </p>
        {enabled && current && search.isError ? (
          <button
            type="button"
            className="timeline-tonal-button"
            onClick={() => void search.refetch()}
          >
            Retry search
          </button>
        ) : null}
      </div>
      <div
        className="timeline-search-results"
        ref={panelRef}
        onScroll={(event) => {
          if (restoredScroll.current)
            scrollPosition.current = event.currentTarget.scrollTop;
        }}
      >
        {enabled && current && search.data
          ? (["BANNER", "EVENT"] as const).map((kind) => {
              const entries = search.data.results.filter(
                (entry) => entry.kind === kind,
              );
              return entries.length ? (
                <section
                  key={kind}
                  className="timeline-search-group"
                  aria-label={kind === "BANNER" ? "Banners" : "Events"}
                >
                  <h4>{kind === "BANNER" ? "Banners" : "Events"}</h4>
                  <ul>
                    {entries.map((entry) => (
                      <TimelineSearchResult
                        key={entry.key}
                        entry={entry}
                        query={debounced}
                        timeZone={timeZone}
                        disabled={selecting !== null}
                        opening={selecting === entry.key}
                        failed={selectionError === entry.key}
                        now={now}
                        expanded={state.expanded.includes(entry.key)}
                        onExpandedChange={(expanded) =>
                          onStateChange((current) => ({
                            ...current,
                            expanded: expanded
                              ? [...new Set([...current.expanded, entry.key])]
                              : current.expanded.filter(
                                  (key) => key !== entry.key,
                                ),
                          }))
                        }
                        onSelect={() => void select(entry)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null;
            })
          : null}
      </div>
    </aside>
  );
}
