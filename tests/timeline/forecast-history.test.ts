// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  forecastHistoryRange,
  mergeForecastIncome,
  useForecastHistory,
} from "~/app/timeline/_components/use-forecast-history";
import type { IncomeContribution } from "~/app/timeline/_lib/income-ledger";

const mocks = vi.hoisted(() => ({ query: vi.fn(), refetch: vi.fn() }));
vi.mock("~/trpc/react", () => ({
  api: { timeline: { income: { useQuery: mocks.query } } },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReturnValue({
    data: undefined,
    isError: false,
    refetch: mocks.refetch,
  });
});
afterEach(cleanup);

it("pads the history query for exact timestamps across local-day boundaries", () => {
  expect(forecastHistoryRange("2026-09-05", "2026-10-17")).toEqual({
    from: new Date("2026-09-03T00:00:00Z"),
    to: new Date("2026-10-19T23:59:59.999Z"),
  });
});

it.each([undefined, "2026-10-17", "2026-10-18"])(
  "does not fetch history for baseline %s",
  (snapshot) => {
    const { result } = renderHook(() =>
      useForecastHistory(snapshot, "2026-10-17", []),
    );
    expect(mocks.query.mock.calls[0]![1]).toMatchObject({ enabled: false });
    expect(result.current.ready).toBe(true);
  },
);

it("withholds forecasts until older public income is available, including empty successful results", () => {
  const { result, rerender } = renderHook(() =>
    useForecastHistory("2026-09-05", "2026-10-17", []),
  );
  expect(result.current.ready).toBe(false);
  expect(mocks.query.mock.calls[0]![1]).toMatchObject({ enabled: true });
  expect(Object.keys(mocks.query.mock.calls[0]![0] as object).sort()).toEqual([
    "from",
    "to",
  ]);
  mocks.query.mockReturnValue({
    data: [],
    isError: false,
    refetch: mocks.refetch,
  });
  rerender();
  expect(result.current.ready).toBe(true);
});

it("does not treat a failed history request as zero income and offers retry", () => {
  mocks.query.mockReturnValue({
    data: undefined,
    isError: true,
    refetch: mocks.refetch,
  });
  const { result } = renderHook(() =>
    useForecastHistory("2026-09-05", "2026-10-17", []),
  );
  const history = result.current;
  expect(history.ready).toBe(false);
  expect(history.failed).toBe(true);
  history.retry();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it("retains same-query data after a background refresh fails", () => {
  mocks.query.mockReturnValue({
    data: [],
    isError: true,
    refetch: mocks.refetch,
  });
  const { result } = renderHook(() =>
    useForecastHistory("2026-09-05", "2026-10-17", []),
  );
  expect(result.current.ready).toBe(true);
});

it("deduplicates overlapping windows and prefers current reward records", () => {
  const earlier = { id: "reward", amount: 3 } as IncomeContribution;
  const current = { id: "reward", amount: 5 } as IncomeContribution;
  const other = { id: "other", amount: 7 } as IncomeContribution;
  expect(mergeForecastIncome([earlier, other], [current])).toEqual([
    current,
    other,
  ]);
});
