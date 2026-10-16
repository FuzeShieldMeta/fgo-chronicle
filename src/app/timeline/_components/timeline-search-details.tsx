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
  expanded,
  onExpandedChange,
  onSelect,
}: {
  entry: TimelineSearchEntry;
  query: string;
  timeZone: string;
  disabled: boolean;
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
        onClick={onSelect}
      >
        <strong className="timeline-search-result-title">{entry.name}</strong>
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
  const [selectionError, setSelectionError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
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
    setSelecting(entry.key);
    setSelectionError(false);
    try {
      await onSelect(entry);
    } catch {
      setSelectionError(true);
    } finally {
      setSelecting(null);
    }
  }
  return (
    <aside
      ref={panelRef}
      className="timeline-details timeline-search-details"
      aria-label="Search timeline"
      onScroll={(event) => {
        if (restoredScroll.current)
          scrollPosition.current = event.currentTarget.scrollTop;
      }}
    >
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
      <label className="timeline-search-field" htmlFor="timeline-search-input">
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
            onStateChange({ query: event.target.value, expanded: [] });
          }}
          aria-describedby="timeline-search-status"
        />
      </label>
      <p id="timeline-search-status" role="status">
        {!enabled ||
        query.trim().length < timelineSearchLimits.minimumQueryCharacters
          ? "Enter at least two characters."
          : !current || search.isFetching
            ? "Searching…"
            : search.isError
              ? "Search could not load. Try again."
              : search.data?.results.length
                ? `${search.data.results.length} results${search.data.hasMore ? ". Refine your search to see more." : "."}`
                : "No matching banners or events. Try a servant name or a shorter title."}
      </p>
      {search.isError ? (
        <button
          type="button"
          className="timeline-tonal-button"
          onClick={() => void search.refetch()}
        >
          Retry search
        </button>
      ) : null}
      {selectionError ? (
        <p role="alert">
          The timeline could not load this result. Try selecting it again.
        </p>
      ) : null}
      {selecting ? (
        <p role="status">Loading the timeline up to this date…</p>
      ) : null}
      {enabled && current && search.data && !search.isError
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
    </aside>
  );
}
