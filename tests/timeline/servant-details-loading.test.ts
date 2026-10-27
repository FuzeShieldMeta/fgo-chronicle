// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const query = vi.hoisted(() => vi.fn());
vi.mock("~/trpc/react", () => {
  const client = { timeline: { servants: { query } } };
  return { api: { useUtils: () => ({ client }) } };
});
import { useServantDetails } from "~/app/timeline/_components/use-servant-details";
type Servant = ReturnType<typeof useServantDetails>["items"][number];
const servant = (id: number): Servant => ({
  id,
  name: `Servant ${id}`,
  className: "Saber",
  rarity: 5,
  atlasNaAvailable: true,
  thumbnailUrl: null,
});
beforeEach(() => {
  query.mockReset();
});
afterEach(cleanup);

it("deduplicates IDs, bounds request batches and reuses details when the panel reopens", async () => {
  query.mockImplementation(async ({ ids }: { ids: number[] }) =>
    ids.map(servant),
  );
  const ids = Array.from({ length: 105 }, (_, index) => index + 1);
  const hook = renderHook(({ ids }) => useServantDetails(ids), {
    initialProps: { ids: [...ids, 1] },
  });
  await waitFor(() =>
    expect(hook.result.current.items).toEqual(ids.map(servant)),
  );
  expect(
    query.mock.calls.map(([input]) => (input as { ids: number[] }).ids.length),
  ).toEqual([100, 5]);
  hook.rerender({ ids: [] });
  expect(hook.result.current.items).toEqual([]);
  hook.rerender({ ids });
  expect(hook.result.current.items).toEqual(ids.map(servant));
  expect(query).toHaveBeenCalledTimes(2);
});

it("retains successful details after failure and retries only missing IDs", async () => {
  query.mockResolvedValueOnce([servant(1)]);
  const hook = renderHook(({ ids }) => useServantDetails(ids), {
    initialProps: { ids: [1] },
  });
  await waitFor(() => expect(hook.result.current.items).toEqual([servant(1)]));
  query.mockRejectedValueOnce(new Error("offline"));
  hook.rerender({ ids: [1, 2] });
  await waitFor(() => expect(hook.result.current.failed).toBe(true));
  expect(hook.result.current.items).toEqual([servant(1)]);
  query.mockResolvedValueOnce([servant(2)]);
  act(() => hook.result.current.retry());
  await waitFor(() =>
    expect(hook.result.current.items).toEqual([servant(1), servant(2)]),
  );
  expect(hook.result.current.failed).toBe(false);
  expect(query.mock.calls[2]?.[0]).toEqual({ ids: [2] });
});

it("aborts closed-panel requests and does not reuse their late results", async () => {
  let finish!: (items: Servant[]) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(({ ids }) => useServantDetails(ids), {
    initialProps: { ids: [1] },
  });
  const signal = (query.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
  hook.rerender({ ids: [] });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish([servant(1)]);
  });
  expect(hook.result.current.items).toEqual([]);
  query.mockResolvedValueOnce([servant(1)]);
  hook.rerender({ ids: [1] });
  await waitFor(() => expect(hook.result.current.items).toEqual([servant(1)]));
  expect(query).toHaveBeenCalledTimes(2);
});
