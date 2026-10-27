// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const query = vi.hoisted(() => vi.fn());
vi.mock("~/trpc/react", () => {
  const client = { timeline: { rewardChoices: { query } } };
  return { api: { useUtils: () => ({ client }) } };
});
import {
  useRewardChoiceDetails,
  type RewardChoiceDetails,
} from "~/app/timeline/_components/use-reward-choice-details";

const reward: RewardChoiceDetails = {
  id: "a",
  name: "Known reward",
  amount: 3,
  itemType: "SAINT_QUARTZ",
  expectedAt: new Date("2026-10-28T04:00:00Z"),
  expectedAtPrecision: "EXACT",
  event: null,
};
beforeEach(() => {
  query.mockReset();
});
afterEach(cleanup);

it("retains successful details, retries only failures, and remembers successful misses", async () => {
  query.mockResolvedValueOnce([reward]);
  const hook = renderHook(({ ids }) => useRewardChoiceDetails(ids), {
    initialProps: { ids: ["a"] },
  });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  query.mockRejectedValueOnce(new Error("offline"));
  hook.rerender({ ids: ["a", "b"] });
  await waitFor(() => expect(hook.result.current.status).toBe("error"));
  expect(hook.result.current.items).toEqual([reward]);
  expect(query.mock.calls[1]?.[0]).toEqual({ ids: ["b"] });
  query.mockResolvedValueOnce([]);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  expect(query.mock.calls[2]?.[0]).toEqual({ ids: ["b"] });
  hook.rerender({ ids: [] });
  expect(hook.result.current.items).toEqual([]);
  hook.rerender({ ids: ["a", "b"] });
  expect(hook.result.current.items).toEqual([reward]);
  expect(hook.result.current.status).toBe("ready");
  expect(query).toHaveBeenCalledTimes(3);
});

it("aborts closed-panel requests and refetches instead of caching stale responses", async () => {
  let finish!: (items: RewardChoiceDetails[]) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(({ ids }) => useRewardChoiceDetails(ids), {
    initialProps: { ids: ["a"] },
  });
  const signal = (query.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
  hook.rerender({ ids: [] });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish([reward]);
  });
  expect(hook.result.current.items).toEqual([]);
  query.mockResolvedValueOnce([reward]);
  hook.rerender({ ids: ["a"] });
  await waitFor(() => expect(hook.result.current.items).toEqual([reward]));
  expect(query).toHaveBeenCalledTimes(2);
});
