"use client";

import { useState } from "react";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";

type Banner = RouterOutputs["curator"]["banners"]["rows"][number];
type Filters = RouterInputs["curator"]["banners"];

export function CuratorBannerVisibility() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>({
    search: "",
    page: 0,
    visibility: "ALL",
  });
  const [selected, setSelected] = useState<Banner | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const utils = api.useUtils();
  const query = api.curator.banners.useQuery(filters, {
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const save = api.curator.setBannerVisibility.useMutation({
    onSuccess: async (result) => {
      setSelected(null);
      setReason("");
      setNotice(
        result.cacheInvalidated
          ? result.banner.hidden
            ? "Banner hidden. Saved plans are unchanged."
            : "Banner restored."
          : "Saved. The public cache could not refresh; reload the timeline.",
      );
      try {
        await Promise.all([
          utils.curator.banners.invalidate(),
          utils.timeline.invalidate(),
          utils.banner.invalidate(),
        ]);
      } catch {
        setNotice("Visibility saved. Reload to see the latest results.");
      }
    },
    onError: (error) => setNotice(error.message),
  });
  return (
    <details
      className="curator-global-queue"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Banner visibility</summary>
      <p>
        Hide outdated or incorrect banners without deleting them or changing
        saved plans. Event visibility is managed in the event editor.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({ ...current, search, page: 0 }));
        }}
      >
        <label>
          Search banners or servants
          <input
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Visibility
          <select
            value={filters.visibility}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                visibility: event.target.value as Filters["visibility"],
                page: 0,
              }))
            }
          >
            <option value="ALL">All</option>
            <option value="VISIBLE">Visible</option>
            <option value="HIDDEN">Hidden</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isFetching && <p role="status">Loading banners…</p>}
      <ul className="curator-global-records">
        {query.data?.rows.map((banner) => (
          <li key={banner.id}>
            <h3>{banner.name}</h3>
            <p>
              {banner.sourceRegion} · {banner.status} ·{" "}
              {banner.startsAt.toISOString().slice(0, 10)} UTC ·{" "}
              {banner.hidden ? "Hidden" : "Visible"}
            </p>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => {
                setSelected(banner);
                setReason("");
                setNotice("");
              }}
            >
              {banner.hidden ? "Restore banner" : "Hide banner"}
            </button>
          </li>
        ))}
      </ul>
      {query.data && !query.data.rows.length && <p>No matching banners.</p>}
      {selected && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({
              bannerId: selected.id,
              hidden: !selected.hidden,
              expectedUpdatedAt: selected.updatedAt,
              reason,
            });
          }}
        >
          <h3>
            {selected.hidden ? "Restore" : "Hide"} {selected.name}
          </h3>
          <label>
            Reason
            <textarea
              required
              minLength={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="curator-actions">
            <button
              type="submit"
              disabled={save.isPending || reason.trim().length < 3}
            >
              {save.isPending
                ? "Saving…"
                : selected.hidden
                  ? "Confirm restore"
                  : "Confirm hide"}
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => setSelected(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="curator-actions">
        <button
          type="button"
          disabled={!filters.page || query.isFetching}
          onClick={() =>
            setFilters((current) => ({
              ...current,
              page: (current.page ?? 0) - 1,
            }))
          }
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!query.data?.hasMore || query.isFetching}
          onClick={() =>
            setFilters((current) => ({
              ...current,
              page: (current.page ?? 0) + 1,
            }))
          }
        >
          Next
        </button>
      </div>
    </details>
  );
}
