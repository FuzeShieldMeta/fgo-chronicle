"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { api, type RouterOutputs } from "~/trpc/react";
import { CuratorReviewActions, reviewLabel } from "./curator-review-actions";
import { CuratorFamilyName } from "./curator-family-name";
import type { RouterInputs } from "~/trpc/react";
import {
  effectiveEvent,
  effectiveReward,
  rewardDateShift,
} from "~/server/services/effective-schedule";

type EventDetail = RouterOutputs["curator"]["event"];
type Reward = EventDetail["rewardSources"][number]["rewards"][number];

const formatDate = (value: Date | null) =>
  value
    ? value.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "Not dated";
const dateInput = (value: Date | null) =>
  value ? value.toISOString().slice(0, 23) : "";
const parseDate = (value: FormDataEntryValue | null) =>
  typeof value === "string" && value ? new Date(value + "Z") : null;
const textField = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};
const items = [
  "SAINT_QUARTZ",
  "SAINT_QUARTZ_FRAGMENT",
  "SUMMON_TICKET",
  "CRYSTALLIZED_LORE",
  "HOLY_GRAIL",
] as const;
const itemName = (value: string) => value.toLowerCase().replaceAll("_", " ");

export function CuratorEditor({
  event: loadedEvent,
  reward: loadedReward,
  onSaved,
  onDirtyChange,
}: {
  event: EventDetail;
  reward?: Reward;
  onSaved: (notice?: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // Background refetches must not advance the revision of an unsaved draft.
  const [draft] = useState(() => ({
    event: loadedEvent,
    reward: loadedReward,
  }));
  const { event, reward } = draft;
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const utils = api.useUtils();
  const save = api.curator.save.useMutation({
    onSuccess: async (result) => {
      setDirty(false);
      onDirtyChange(false);
      await utils.curator.events.invalidate();
      await utils.curator.history.invalidate();
      await onSaved(
        result.cacheInvalidated
          ? "Saved."
          : "Saved. The public cache could not refresh. It will expire automatically.",
      );
    },
    onError: (error) => {
      setNotice(
        error.data?.zodError?.fieldErrors.values?.[0] ??
          error.data?.zodError?.fieldErrors.reason?.[0] ??
          error.message,
      );
      setResetPending(false);
    },
  });
  const targetKind = reward ? ("REWARD" as const) : ("EVENT" as const);
  const targetId = reward?.id ?? event.id;
  const revision = (reward ? reward.curation : event.curation)?.revision ?? 0;
  const active = (reward ? reward.curation : event.curation)?.active ?? false;
  const history = api.curator.history.useQuery(
    { targetKind, targetId, page: 0 },
    { refetchOnWindowFocus: false },
  );
  const [historyPage, setHistoryPage] = useState(0);
  const olderHistory = api.curator.history.useQuery(
    { targetKind, targetId, page: historyPage },
    { enabled: historyPage > 0, refetchOnWindowFocus: false },
  );
  const displayedHistory = historyPage ? olderHistory : history;
  const effective = reward
    ? effectiveReward(reward, rewardDateShift(event))
    : null;
  const schedule = effectiveEvent(event);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const values = reward
      ? {
          itemType: data.get("itemType") as (typeof items)[number],
          amount: Number(data.get("amount")),
          expectedAt: parseDate(data.get("expectedAt")),
          nature: data.get("nature") as
            "DETERMINISTIC" | "CONDITIONAL" | "CURATED_ESTIMATE",
          eligibility: textField(data, "eligibility").trim() || null,
          defaultIncluded: data.get("defaultIncluded") === "on",
        }
      : {
          name: textField(data, "name"),
          startsAt: parseDate(data.get("startsAt"))!,
          startsAtPrecision: data.get("startsAtPrecision") as
            "DATE_ONLY" | "EXACT",
          endsAt: parseDate(data.get("endsAt")),
          endsAtPrecision: data.get("endsAt")
            ? (data.get("endsAtPrecision") as "DATE_ONLY" | "EXACT")
            : null,
          hidden: data.get("hidden") === "on",
          shiftRewardDates: data.get("shiftRewardDates") === "on",
        };
    save.mutate({
      targetKind,
      targetId,
      expectedRevision: revision,
      reason,
      values,
    });
  }

  return (
    <section
      className="curator-editor"
      aria-label={reward ? "Reward editor" : "Event editor"}
    >
      <h2>{reward ? "Edit reward" : "Edit event"}</h2>
      <p>
        {active ? "Uses curator changes." : "Uses imported values."} Revision{" "}
        {revision}.
      </p>
      <CuratorReviewActions
        event={event}
        reward={reward}
        dirty={dirty}
        onReviewed={onSaved}
      />
      <details className="curator-source">
        <summary>Imported values and evidence</summary>
        {reward ? (
          <dl>
            <dt>Item</dt>
            <dd>{itemName(reward.itemType)}</dd>
            <dt>Amount</dt>
            <dd>{reward.amount}</dd>
            <dt>Date</dt>
            <dd>{formatDate(reward.expectedAt)}</dd>
            <dt>Eligibility</dt>
            <dd>{reward.eligibility ?? "None recorded"}</dd>
          </dl>
        ) : (
          <dl>
            <dt>Name</dt>
            <dd>{event.name}</dd>
            <dt>Start</dt>
            <dd>{formatDate(event.startsAt)}</dd>
            <dt>End</dt>
            <dd>{formatDate(event.endsAt)}</dd>
            <dt>Source key</dt>
            <dd>{event.sourceKey}</dd>
          </dl>
        )}
        {(
          reward
            ? event.rewardSources.find(
                (source) => source.id === reward.rewardSourceId,
              )?.evidenceUrl
            : event.sourceUrl
        ) ? (
          <a
            href={
              (reward
                ? event.rewardSources.find(
                    (source) => source.id === reward.rewardSourceId,
                  )?.evidenceUrl
                : event.sourceUrl) ?? undefined
            }
            target="_blank"
            rel="noreferrer"
          >
            View source
          </a>
        ) : (
          <p>No source link recorded.</p>
        )}
      </details>
      <form
        onSubmit={submit}
        onChange={() => {
          setDirty(true);
          onDirtyChange(true);
        }}
      >
        <fieldset disabled={save.isPending}>
          <legend className="curator-sr-only">Correction</legend>
          {reward && effective ? (
            <>
              <label>
                Item
                <select name="itemType" defaultValue={effective.itemType}>
                  {items.map((item) => (
                    <option key={item} value={item}>
                      {itemName(item)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input
                  name="amount"
                  type="number"
                  min="0"
                  max="2147483647"
                  required
                  step="1"
                  defaultValue={effective.amount}
                />
              </label>
              <label>
                Reward date and time (UTC)
                <input
                  name="expectedAt"
                  type="datetime-local"
                  step="0.001"
                  defaultValue={dateInput(effective.expectedAt)}
                />
              </label>
              <label>
                Reward nature
                <select name="nature" defaultValue={effective.nature}>
                  <option value="DETERMINISTIC">Deterministic</option>
                  <option value="CONDITIONAL">Conditional</option>
                  <option value="CURATED_ESTIMATE">Curated estimate</option>
                </select>
              </label>
              <label>
                Eligibility
                <textarea
                  name="eligibility"
                  maxLength={4000}
                  defaultValue={effective.eligibility ?? ""}
                />
              </label>
              <label className="curator-checkbox">
                <input
                  name="defaultIncluded"
                  type="checkbox"
                  defaultChecked={effective.defaultIncluded}
                />
                Include by default
              </label>
              <p>
                Story requirements and player inclusion choices remain
                unchanged. An undated reward does not appear in dated income.
              </p>
            </>
          ) : (
            <>
              <label>
                Name
                <input
                  name="name"
                  required
                  maxLength={300}
                  defaultValue={schedule.name}
                />
              </label>
              <div className="curator-field-row">
                <label>
                  Start (UTC)
                  <input
                    name="startsAt"
                    required
                    type="datetime-local"
                    step="0.001"
                    defaultValue={dateInput(schedule.startsAt)}
                  />
                </label>
                <label>
                  Start precision
                  <select
                    name="startsAtPrecision"
                    defaultValue={schedule.startsAtPrecision}
                  >
                    <option value="DATE_ONLY">Date only</option>
                    <option value="EXACT">Exact time</option>
                  </select>
                </label>
              </div>
              <div className="curator-field-row">
                <label>
                  End (UTC)
                  <input
                    name="endsAt"
                    type="datetime-local"
                    step="0.001"
                    defaultValue={dateInput(schedule.endsAt)}
                  />
                </label>
                <label>
                  End precision
                  <select
                    name="endsAtPrecision"
                    defaultValue={schedule.endsAtPrecision ?? "EXACT"}
                  >
                    <option value="DATE_ONLY">Date only</option>
                    <option value="EXACT">Exact time</option>
                  </select>
                </label>
              </div>
              <label className="curator-checkbox">
                <input
                  name="shiftRewardDates"
                  type="checkbox"
                  defaultChecked={
                    event.curation?.active
                      ? event.curation.shiftRewardDates
                      : true
                  }
                />
                Move non-overridden reward dates with the event
              </label>
              <label className="curator-checkbox">
                <input
                  name="hidden"
                  type="checkbox"
                  defaultChecked={
                    event.curation?.active && event.curation.hidden
                  }
                />
                Hide this event and its rewards from the public timeline
              </label>
            </>
          )}
          <label>
            Reason
            <input
              name="reason"
              required
              minLength={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="curator-actions">
            <button type="submit" className="curator-primary">
              {save.isPending ? "Saving…" : "Save correction"}
            </button>
            <button
              type="button"
              disabled={!active || reason.trim().length < 3}
              onClick={() => setResetPending(true)}
            >
              Use imported values
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm(
                    "Discard unsaved changes and reload this record?",
                  )
                ) {
                  onDirtyChange(false);
                  void onSaved();
                }
              }}
            >
              Reload record
            </button>
          </div>
          {resetPending && (
            <div
              className="curator-confirm"
              role="group"
              aria-label="Confirm reset"
            >
              <p>
                Remove this correction and use the latest imported values? This
                also restores a hidden event.
              </p>
              <button
                type="button"
                onClick={() =>
                  save.mutate({
                    targetKind,
                    targetId,
                    expectedRevision: revision,
                    reason,
                    values: null,
                  })
                }
              >
                Confirm reset
              </button>
              <button type="button" onClick={() => setResetPending(false)}>
                Cancel
              </button>
            </div>
          )}
        </fieldset>
      </form>
      {notice && (
        <p role="status" className="curator-notice">
          {notice}
        </p>
      )}
      <section className="curator-history">
        <h3>Change history</h3>
        {displayedHistory.isPending && <p role="status">Loading history…</p>}
        {displayedHistory.error && (
          <p role="alert">{displayedHistory.error.message}</p>
        )}
        {displayedHistory.data?.length === 0 && (
          <p>No curator changes recorded.</p>
        )}
        {displayedHistory.data?.map((change) => (
          <details key={change.id}>
            <summary>
              {formatDate(change.createdAt)} · {change.action.toLowerCase()} ·{" "}
              {change.reason}
            </summary>
            <p>Curator account: {change.actorId}</p>
            <h4>Before</h4>
            <pre>{JSON.stringify(change.before, null, 2)}</pre>
            <h4>After</h4>
            <pre>{JSON.stringify(change.after, null, 2)}</pre>
          </details>
        ))}
        <div className="curator-actions">
          <button
            disabled={historyPage === 0}
            onClick={() => setHistoryPage((p) => p - 1)}
          >
            Newer changes
          </button>
          <button
            disabled={(displayedHistory.data?.length ?? 0) < 25}
            onClick={() => setHistoryPage((p) => p + 1)}
          >
            Older changes
          </button>
        </div>
      </section>
    </section>
  );
}

export function CuratorDashboard() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  type Filters = Omit<RouterInputs["curator"]["events"], "search" | "page">;
  const [filters, setFilters] = useState<Filters>({
    sort: "EARLIEST_UNREVIEWED",
    visibility: "VISIBLE",
    view: "ALL",
  });
  function filter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }
  const [eventId, setEventId] = useState<string | null>(null);
  const [rewardId, setRewardId] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [familyDirty, setFamilyDirty] = useState(false);
  const [familyEpoch, setFamilyEpoch] = useState(0);
  const [notice, setNotice] = useState("");
  const events = api.curator.events.useQuery(
    { search: query, page, ...filters },
    { refetchOnWindowFocus: false },
  );
  const detail = api.curator.event.useQuery(
    { id: eventId ?? "" },
    { enabled: Boolean(eventId), refetchOnWindowFocus: false },
  );
  const event = detail.data;
  const reward = event?.rewardSources
    .flatMap((source) => source.rewards)
    .find((value) => value.id === rewardId);
  async function reload(message = "") {
    const result = await detail.refetch();
    if (result.error) {
      setNotice("Could not reload the event. Your edits have been kept.");
      return;
    }
    setEditorEpoch((p) => p + 1);
    setNotice(message);
  }
  function select(id: string, reward: string | null) {
    if (
      (editorDirty || familyDirty) &&
      !window.confirm("Leave this editor? Unsaved changes will be lost.")
    )
      return;
    setEditorDirty(false);
    setFamilyDirty(false);
    setFamilyEpoch((value) => value + 1);
    setNotice("");
    setEventId(id);
    setRewardId(reward);
    setEditorEpoch((p) => p + 1);
  }
  return (
    <div className="curator-workspace">
      <aside className="curator-event-list" aria-label="Events">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
            setPage(0);
          }}
        >
          <label>
            Search events
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={200}
            />
          </label>
          <button>Search</button>
        </form>
        <label>
          Queue
          <select
            value={filters.view}
            onChange={(e) => filter("view", e.target.value as Filters["view"])}
          >
            <option value="ALL">All</option>
            <option value="UNREVIEWED">Unreviewed</option>
            <option value="NEEDS_REVIEW">Needs re-review</option>
            <option value="SOURCE_CHANGED">Source changed</option>
            <option value="MISSING_EVIDENCE">Missing evidence</option>
            <option value="CORRECTED">Corrected</option>
            <option value="HIDDEN">Hidden</option>
          </select>
        </label>
        <label>
          Sort
          <select
            value={filters.sort}
            onChange={(e) => filter("sort", e.target.value as Filters["sort"])}
          >
            <option value="EARLIEST_UNREVIEWED">Earliest unreviewed</option>
            <option value="EARLIEST">Earliest event</option>
            <option value="LATEST">Latest event</option>
          </select>
        </label>
        <details className="curator-queue-filters">
          <summary>Filters</summary>
          <label>
            Visibility
            <select
              value={filters.visibility}
              onChange={(e) =>
                filter("visibility", e.target.value as Filters["visibility"])
              }
            >
              <option value="VISIBLE">Visible</option>
              <option value="ALL">Include hidden</option>
              <option value="HIDDEN">Hidden only</option>
            </select>
          </label>
          <label>
            Schedule status
            <select
              value={filters.status ?? ""}
              onChange={(e) =>
                filter(
                  "status",
                  (e.target.value || undefined) as Filters["status"],
                )
              }
            >
              <option value="">All statuses</option>
              <option value="PROJECTED">Projected</option>
              <option value="CURATED">Curated</option>
              <option value="OFFICIAL">Official</option>
            </select>
          </label>
          <label>
            Event type
            <select
              value={filters.type ?? ""}
              onChange={(e) =>
                filter("type", (e.target.value || undefined) as Filters["type"])
              }
            >
              <option value="">All types</option>
              {[
                "MAIN_EVENT",
                "PRE_RELEASE_CAMPAIGN",
                "LOGIN_BONUS",
                "CAMPAIGN",
                "EVENT_SHOP",
                "QUEST_RELEASE",
                "LIMITED_MISSION",
                "MAINTENANCE",
                "OTHER",
              ].map((type) => (
                <option key={type} value={type}>
                  {itemName(type)}
                </option>
              ))}
            </select>
          </label>
          <label>
            From (UTC)
            <input
              type="date"
              value={filters.from?.toISOString().slice(0, 10) ?? ""}
              onChange={(e) =>
                filter(
                  "from",
                  e.target.value
                    ? new Date(e.target.value + "T00:00:00.000Z")
                    : undefined,
                )
              }
            />
          </label>
          <label>
            Through (UTC)
            <input
              type="date"
              value={filters.to?.toISOString().slice(0, 10) ?? ""}
              onChange={(e) =>
                filter(
                  "to",
                  e.target.value
                    ? new Date(e.target.value + "T23:59:59.999Z")
                    : undefined,
                )
              }
            />
          </label>
        </details>
        {events.isPending && <p role="status">Loading events…</p>}
        {events.error && <p role="alert">{events.error.message}</p>}
        <p>{events.data?.count ?? 0} matching events</p>
        <ul>
          {events.data?.events.map((value) => (
            <li key={value.id}>
              <button
                aria-pressed={eventId === value.id}
                onClick={() => select(value.id, null)}
              >
                <span>{value.name}</span>
                <small>
                  {formatDate(value.startsAt)}
                  {value.hidden ? " · Hidden" : ""}
                </small>
                <small>
                  Event: {reviewLabel(value.eventReview)} · Rewards:{" "}
                  {value.rewardCounts.reviewed}/{value.rewardCounts.total}{" "}
                  reviewed
                </small>
                <small>
                  {value.badges
                    .map((badge) =>
                      badge === "NEEDS_REVIEW"
                        ? "Needs re-review"
                        : itemName(badge),
                    )
                    .join(" · ")}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <div className="curator-actions">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            disabled={!events.data || (page + 1) * 25 >= events.data.count}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </aside>
      <div className="curator-detail">
        {notice && (
          <p role="status" className="curator-notice">
            {notice}
          </p>
        )}
        {detail.isFetching && eventId && <p role="status">Loading record…</p>}
        {detail.error && <p role="alert">{detail.error.message}</p>}
        {!eventId && <p>Select an event to review its dates and rewards.</p>}
        {event && (
          <>
            {event.familyId && (
              <CuratorFamilyName
                key={`${event.id}:${event.familyId}:${familyEpoch}`}
                familyId={event.familyId}
                onDirtyChange={setFamilyDirty}
              />
            )}
            <nav className="curator-targets" aria-label="Record to edit">
              <button
                aria-pressed={!rewardId}
                onClick={() => select(event.id, null)}
              >
                Event dates and visibility · {reviewLabel(event.review.status)}
              </button>
              {event.rewardSources.map((source) => (
                <div key={source.id}>
                  <h3>{source.name}</h3>
                  {source.rewards.map((value) => (
                    <button
                      key={value.id}
                      aria-pressed={rewardId === value.id}
                      onClick={() => select(event.id, value.id)}
                    >
                      {itemName(
                        value.curation?.active
                          ? value.curation.itemType
                          : value.itemType,
                      )}{" "}
                      ·{" "}
                      {value.curation?.active
                        ? value.curation.amount
                        : value.amount}{" "}
                      · {reviewLabel(value.review.status)}
                    </button>
                  ))}
                </div>
              ))}
              {!event.rewardSources.length && (
                <p>No reward sources recorded.</p>
              )}
            </nav>
            <CuratorEditor
              key={`${event.id}:${rewardId ?? "event"}:${editorEpoch}`}
              event={event}
              reward={reward}
              onSaved={reload}
              onDirtyChange={setEditorDirty}
            />
          </>
        )}
      </div>
    </div>
  );
}
