"use client";

import { useMemo, type CSSProperties } from "react";

import {
  incomeResourceLabels,
  type IncomeLedgerCell,
} from "~/app/timeline/_lib/income-ledger";
import { forecastResourceTypes } from "~/app/timeline/_lib/player-forecast";
import { timelineLayout } from "~/app/timeline/_lib/timeline-layout-config";

const compactAmount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 0,
});

function displayAmount(value: number) {
  return Math.abs(value) >= 10_000
    ? compactAmount.format(value)
    : String(value);
}

function signedAmount(value: number, compact = false) {
  const amount = compact
    ? displayAmount(Math.abs(value))
    : String(Math.abs(value));
  if (value > 0) return `+${amount}`;
  if (value < 0) return `−${amount}`;
  return "0";
}

export function TimelineIncomeLedger({
  days,
  cells,
  selectedKey,
  onSelect,
}: {
  days: string[];
  cells: Map<string, IncomeLedgerCell>;
  selectedKey: string | null;
  onSelect: (cell: IncomeLedgerCell) => void;
}) {
  const dayIndexes = useMemo(
    () => new Map(days.map((day, index) => [day, index])),
    [days],
  );
  const cellsByResource = useMemo(() => {
    const grouped = new Map(
      forecastResourceTypes.map((itemType) => [
        itemType,
        [] as IncomeLedgerCell[],
      ]),
    );
    for (const cell of cells.values()) grouped.get(cell.itemType)?.push(cell);
    return grouped;
  }, [cells]);

  return (
    <section
      className="timeline-category timeline-income-ledger"
      data-category="INCOME_SOURCE"
      aria-label="Resource changes by resource and date"
    >
      {forecastResourceTypes.map((itemType) => {
        const resourceCells = cellsByResource.get(itemType) ?? [];

        return (
          <div
            key={itemType}
            className="timeline-income-row"
            data-resource={itemType}
            aria-label={incomeResourceLabels[itemType]}
          >
            {resourceCells.map((cell) => {
              const dayIndex = dayIndexes.get(cell.day);
              if (dayIndex === undefined) return null;
              const unresolvedAmount = cell.contributions.reduce(
                (total, contribution) =>
                  total +
                  (contribution.inclusionResolved ? 0 : contribution.amount),
                0,
              );
              const decisionDescription = cell.hasUnresolvedConditional
                ? ` ${unresolvedAmount} ${incomeResourceLabels[itemType]} needs your choice and is not included in the balance.`
                : "";

              const style = {
                left: dayIndex * timelineLayout.dayWidth,
                width: timelineLayout.dayWidth,
              } as CSSProperties;

              return (
                <button
                  key={cell.key}
                  type="button"
                  className="timeline-income-cell"
                  data-direction={
                    cell.delta > 0
                      ? "GAIN"
                      : cell.delta < 0
                        ? "SPEND"
                        : "NEUTRAL"
                  }
                  data-selected={selectedKey === cell.key ? "true" : "false"}
                  data-needs-decision={
                    cell.hasUnresolvedConditional ? "true" : undefined
                  }
                  style={style}
                  aria-label={`${incomeResourceLabels[itemType]} ${signedAmount(cell.delta)} on ${cell.day}${cell.closingBalance === null ? ". Add starting balances to calculate a closing balance." : `. Closing balance ${cell.closingBalance}.`}${decisionDescription}`}
                  title={`Resource change: ${signedAmount(cell.delta)}. Closing balance: ${cell.closingBalance ?? "unknown"}. Excluded rewards are not counted.${decisionDescription}`}
                  aria-pressed={selectedKey === cell.key}
                  onClick={() => onSelect(cell)}
                >
                  {cell.hasUnresolvedConditional ? (
                    <span
                      className="timeline-income-decision-marker"
                      aria-hidden="true"
                    >
                      {displayAmount(unresolvedAmount)}?
                    </span>
                  ) : null}
                  <strong>{signedAmount(cell.delta, true)}</strong>
                  <small>
                    {cell.closingBalance === null
                      ? "—"
                      : displayAmount(cell.closingBalance)}
                  </small>
                </button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
