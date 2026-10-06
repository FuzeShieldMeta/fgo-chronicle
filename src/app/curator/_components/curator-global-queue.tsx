"use client";

import { useState } from "react";
import { CuratorGlobalPreview } from "./curator-global-preview";
import { api, type RouterInputs } from "~/trpc/react";
import {
  GLOBAL_SOURCE_LIMITS,
  MILLISECONDS_PER_DAY,
} from "~/shared/global-reconciliation-config";

type QueueInput = RouterInputs["curator"]["globalCandidates"];
const utcDate = (value: Date) => value.toISOString().split("T")[0]!;
const dateLabel = (value: Date | null) =>
  value
    ? value.toISOString().replace("T", " ").split(".")[0] + " UTC"
    : "No valid date";

export function CuratorGlobalQueue({
  onSelectEvent,
}: {
  onSelectEvent: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => utcDate(new Date()));
  const [through, setThrough] = useState(() =>
    utcDate(
      new Date(
        Date.now() +
          GLOBAL_SOURCE_LIMITS.defaultRangeDays * MILLISECONDS_PER_DAY,
      ),
    ),
  );
  const [input, setInput] = useState<QueueInput>({
    page: 0,
    view: "ALL",
    sort: "NEWEST",
  });
  const [notice, setNotice] = useState("");
  const utils = api.useUtils();
  const queue = api.curator.globalCandidates.useQuery(input, { enabled: open });
  const collect = api.curator.collectGlobalCandidates.useMutation({
    onSuccess: async (result) => {
      setNotice(
        `Collected ${result.inserted} new source assessments from ${result.examined} records. Nothing was published.`,
      );
      setInput((current) => ({ ...current, page: 0 }));
      await utils.curator.globalCandidates.invalidate();
    },
    onError: (error) => setNotice(error.message),
  });
  const announcements = api.curator.collectAnnouncements.useMutation({
    onSuccess: async (result) => {
      setNotice(
        `Collected ${result.inserted} new announcement assessments. Updated official dates for ${result.publishedCount} events.${result.publicationFailures ? ` ${result.publicationFailures} matches need review.` : ""}${result.coverageLimited ? " Collection reached its coverage limit." : ""}`,
      );
      setInput((current) => ({
        ...current,
        page: 0,
        source: "PUBLISHER_ANNOUNCEMENT",
      }));
      try {
        await utils.curator.globalCandidates.invalidate();
        if (result.published)
          await Promise.all([
            utils.curator.invalidate(),
            utils.timeline.invalidate(),
          ]);
      } catch {
        setNotice(
          "Announcement assessments were saved. Reload the queue to see them.",
        );
      }
    },
    onError: (error) => setNotice(error.message),
  });
  const collecting = collect.isPending || announcements.isPending;
  return (
    <details
      className="curator-global-queue"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Global source queue</summary>
      <p>
        Collect Atlas Global game-data candidates for review. This does not
        change the public schedule or rewards.
      </p>
      <form
        aria-busy={collecting}
        onSubmit={(event) => {
          event.preventDefault();
          setNotice("");
          collect.mutate({
            from: new Date(`${from}T00:00:00Z`),
            through: new Date(`${through}T23:59:59.999Z`),
          });
        }}
      >
        <div className="curator-field-row">
          <label>
            From (UTC)
            <input
              type="date"
              required
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            Through (UTC)
            <input
              type="date"
              required
              min={from}
              value={through}
              onChange={(event) => setThrough(event.target.value)}
            />
          </label>
        </div>
        <button type="submit" disabled={collecting}>
          {collect.isPending
            ? "Collecting source records…"
            : "Collect Global candidates"}
        </button>
        <p>
          Choose up to {GLOBAL_SOURCE_LIMITS.maxRangeDays} days. Source
          revisions stay in the queue. Malformed dates appear as unresolved
          issues.
        </p>
      </form>
      <div aria-busy={announcements.isPending}>
        <button
          type="button"
          disabled={collecting}
          onClick={() => {
            setNotice("");
            announcements.mutate({});
          }}
        >
          {announcements.isPending
            ? "Collecting announcements…"
            : "Collect publisher announcements"}
        </button>
        <p>
          Checks recent official news and maintenance articles. Unique event
          matches update official dates and relative family dates. Other periods
          and unsupported formats stay in the review queue. The date range above
          applies only to Atlas records.
        </p>
      </div>
      {notice ? (
        <p className="curator-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="curator-field-row">
        <label>
          Source type
          <select
            value={input.source ?? "ALL"}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                page: 0,
                source: event.target.value as QueueInput["source"],
              }))
            }
          >
            <option value="ALL">All sources</option>
            <option value="GLOBAL_GAME_DATA">Atlas Global game data</option>
            <option value="PUBLISHER_ANNOUNCEMENT">
              Publisher announcements
            </option>
          </select>
        </label>
        <label>
          Candidate filter
          <select
            value={input.view}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                page: 0,
                view: event.target.value as QueueInput["view"],
              }))
            }
          >
            <option value="ALL">All source assessments</option>
            <option value="MATCHED">Matched events</option>
            <option value="UNRESOLVED">Unresolved records</option>
          </select>
        </label>
        <label>
          Candidate order
          <select
            value={input.sort}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                page: 0,
                sort: event.target.value as QueueInput["sort"],
              }))
            }
          >
            <option value="NEWEST">Newest assessment</option>
            <option value="EARLIEST">Earliest event</option>
          </select>
        </label>
      </div>
      <div aria-busy={queue.isFetching}>
        {queue.isPending ? <p role="status">Loading source queue…</p> : null}
        {queue.error ? (
          <p role="alert">
            Could not load the source queue.{" "}
            <button type="button" onClick={() => void queue.refetch()}>
              Retry
            </button>
          </p>
        ) : null}
        {queue.data ? (
          <>
            <p>
              {queue.data.total} source assessments. Page{" "}
              {(input.page ?? 0) + 1}.
            </p>
            {!queue.data.entries.length ? (
              <p>No source assessments in this view.</p>
            ) : null}
            <ul className="curator-global-records">
              {queue.data.entries.map((entry) => (
                <li key={entry.id}>
                  <h3>{entry.name}</h3>
                  {entry.sourceKind === "PUBLISHER_ANNOUNCEMENT" ? (
                    <p>Publisher announcement. Review only.</p>
                  ) : null}
                  <p>
                    {dateLabel(entry.startsAt)} to {dateLabel(entry.endsAt)}
                  </p>
                  <p>
                    {entry.targetEventId
                      ? entry.published
                        ? "Current published Global source."
                        : "Matched to an existing event. Not published."
                      : "Unresolved. Not published."}
                  </p>
                  {entry.reasons.length ? (
                    <ul>
                      {entry.reasons.map((reason) => (
                        <li key={reason}>
                          {reason.toLowerCase().replaceAll("_", " ")}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p>
                    <a
                      href={entry.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source record
                    </a>{" "}
                    · Retrieved {dateLabel(entry.retrievedAt)}
                  </p>
                  {entry.targetEventId ? (
                    <button
                      type="button"
                      onClick={() => onSelectEvent(entry.targetEventId!)}
                    >
                      Open matched event
                    </button>
                  ) : null}
                  {entry.targetEventId ? (
                    <CuratorGlobalPreview candidateId={entry.id} />
                  ) : null}
                  <details>
                    <summary>Source assessment details</summary>
                    <pre>{JSON.stringify(entry.snapshot, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
            <nav
              className="curator-actions"
              aria-label="Global source queue pages"
            >
              <button
                type="button"
                disabled={!input.page || queue.isFetching}
                onClick={() =>
                  setInput((current) => ({
                    ...current,
                    page: (current.page ?? 0) - 1,
                  }))
                }
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!queue.data.hasNext || queue.isFetching}
                onClick={() =>
                  setInput((current) => ({
                    ...current,
                    page: (current.page ?? 0) + 1,
                  }))
                }
              >
                Next
              </button>
            </nav>
          </>
        ) : null}
      </div>
    </details>
  );
}
