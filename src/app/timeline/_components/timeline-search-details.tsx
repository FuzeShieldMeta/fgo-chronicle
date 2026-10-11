"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { calendarDayKey } from "../_lib/schedule-layout";
import {
  timelineSearchLimits,
  servantMatchesSearch,
  type TimelineSearchEntry,
} from "~/shared/timeline-search";

const statuses = {
  OFFICIAL: "Official",
  CURATED: "Curated",
  PROJECTED: "Projected",
};

export function TimelineSearchDetails({
  scheduleStartDay,
  timeZone,
  onSelect,
  onClose,
}: {
  scheduleStartDay: string;
  timeZone: string;
  onSelect: (entry: TimelineSearchEntry) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Run after the shared details layer focuses its close button.
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => inputRef.current?.focus());
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
      className="timeline-details timeline-search-details"
      aria-label="Search timeline"
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
          onChange={(event) => setQuery(event.target.value)}
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
                : "No matching banners or events."}
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
                    <li key={entry.key}>
                      <button
                        type="button"
                        className="timeline-search-result"
                        disabled={selecting !== null}
                        onClick={() => void select(entry)}
                      >
                        <strong>{entry.name}</strong>
                        <span>
                          {calendarDayKey(
                            entry.startsAt,
                            entry.startsAtPrecision,
                            timeZone,
                          )}
                          {entry.endsAt
                            ? ` – ${calendarDayKey(entry.endsAt, entry.endsAtPrecision ?? "EXACT", timeZone)}`
                            : ""}{" "}
                          · {statuses[entry.status]}
                        </span>
                        {entry.servants.length ? (
                          <span>
                            {entry.servants.map((servant, index) => (
                              <span key={servant.id}>
                                {index ? ", " : ""}
                                {servantMatchesSearch(servant, debounced) ? (
                                  <strong>{servant.name}</strong>
                                ) : (
                                  servant.name
                                )}{" "}
                                ({servant.className})
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null;
          })
        : null}
    </aside>
  );
}
