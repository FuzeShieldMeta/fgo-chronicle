"use client";

import { useMemo } from "react";
import { api } from "~/trpc/react";
import { timelineSchedule } from "../_lib/timeline-layout-config";
import type { IncomeContribution } from "../_lib/income-ledger";

export function forecastHistoryRange(
  snapshotDay: string | undefined,
  today: string,
) {
  const from = new Date(`${snapshotDay ?? today}T00:00:00.000Z`);
  const to = new Date(`${today}T23:59:59.999Z`);
  from.setUTCDate(
    from.getUTCDate() - timelineSchedule.queryBoundaryPaddingDays,
  );
  to.setUTCDate(to.getUTCDate() + timelineSchedule.queryBoundaryPaddingDays);
  return { from, to };
}

export function mergeForecastIncome(
  history: readonly IncomeContribution[],
  current: readonly IncomeContribution[],
) {
  return [
    ...new Map(
      [...history, ...current].map((item) => [item.id, item]),
    ).values(),
  ];
}

export function useForecastHistory(
  snapshotDay: string | undefined,
  today: string,
  current: IncomeContribution[],
) {
  const needed = Boolean(snapshotDay && snapshotDay < today);
  const range = useMemo(
    () => forecastHistoryRange(snapshotDay, today),
    [snapshotDay, today],
  );
  // Only public reward data is requested. Planner balances and choices stay local.
  // Reuse the existing bounded endpoint rather than loading past timeline rails.
  const history = api.timeline.income.useQuery(range, {
    enabled: needed,
    staleTime: timelineSchedule.detailsStaleTimeMs,
    refetchOnWindowFocus: false,
  });
  const income = useMemo(
    () => mergeForecastIncome(needed ? (history.data ?? []) : [], current),
    [current, needed, history.data],
  );
  return {
    income,
    ready: !needed || history.data !== undefined,
    failed: needed && history.isError,
    retry: () => void history.refetch(),
  };
}
