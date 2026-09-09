"use client";

import type { CSSProperties } from "react";

import {
  incomeResourceLabels,
  type IncomeLedgerCell,
} from "~/app/timeline/_lib/income-ledger";
import { forecastResourceTypes } from "~/app/timeline/_lib/player-forecast";
import { timelineLayout } from "~/app/timeline/_lib/timeline-layout-config";

function signedAmount(value: number) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
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
  const dayIndexes = new Map(days.map((day, index) => [day, index]));

  return (
    <section
      className="timeline-category timeline-income-ledger"
      data-category="INCOME_SOURCE"
      aria-label="Income sources by resource and date"
    >
      {forecastResourceTypes.map((itemType) => {
        const resourceCells = [...cells.values()].filter(
          (cell) => cell.itemType === itemType,
        );

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
                  aria-label={`${incomeResourceLabels[itemType]} ${signedAmount(cell.delta)} on ${cell.day}${cell.closingBalance === null ? ". Add starting balances to calculate a closing balance." : `. Closing balance ${cell.closingBalance}.`}${cell.hasUnresolvedConditional ? " Contains a conditional reward that needs your choice." : ""}`}
                  aria-pressed={selectedKey === cell.key}
                  onClick={() => onSelect(cell)}
                >
                  <strong>{signedAmount(cell.delta)}</strong>
                  <small>{cell.closingBalance ?? "—"}</small>
                  {cell.hasUnresolvedConditional ? (
                    <span
                      className="timeline-income-decision-marker"
                      aria-hidden="true"
                    >
                      ?
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
