"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type {
  PlannerCloudSnapshot,
  PlannerStatePayload,
} from "~/app/timeline/_lib/planner-state";

function payloadSummary(payload: PlannerStatePayload) {
  return {
    hasProfile: payload.profile !== null,
    rewardChoices: Object.keys(payload.rewardPreferences.includedByRewardId)
      .length,
    sessions: payload.summonSessions.length,
  };
}

function CopySummary({
  title,
  payload,
  updatedAt,
}: {
  title: string;
  payload: PlannerStatePayload;
  updatedAt?: Date;
}) {
  const summary = payloadSummary(payload);
  return (
    <section className="planner-conflict-copy">
      <h3>{title}</h3>
      {updatedAt ? (
        <p>
          Updated{" "}
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(updatedAt)}
        </p>
      ) : null}
      <ul>
        <li>{summary.hasProfile ? "Balances entered" : "No balances"}</li>
        <li>{summary.rewardChoices} reward choices</li>
        <li>{summary.sessions} summon sessions</li>
      </ul>
    </section>
  );
}

export function PlannerSyncConflictDialog({
  localPayload,
  cloud,
  onKeepDevice,
  onKeepCloud,
  onClose,
}: {
  localPayload: PlannerStatePayload;
  cloud: PlannerCloudSnapshot;
  onKeepDevice: () => void;
  onKeepCloud: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const page = document.querySelector<HTMLElement>(".timeline-page");
    const previousInert = page?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (page) page.inert = true;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[data-primary-action]")
      ?.focus();

    return () => {
      if (page) page.inert = previousInert;
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="planner-conflict-backdrop">
      <div
        ref={dialogRef}
        className="planner-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="planner-conflict-heading"
        onKeyDown={handleKeyDown}
      >
        <div className="planner-conflict-header">
          <div>
            <span className="timeline-type-label">Sync paused</span>
            <h2 id="planner-conflict-heading">Choose which copy to keep</h2>
          </div>
          <button
            type="button"
            className="planner-conflict-close"
            onClick={onClose}
            aria-label="Close sync choice"
          >
            Close
          </button>
        </div>
        <p>
          This device and your account both contain planner changes. Keeping one
          copy replaces the other.
        </p>
        <div className="planner-conflict-copies">
          <CopySummary title="This device" payload={localPayload} />
          <CopySummary
            title="Cloud copy"
            payload={cloud.payload}
            updatedAt={cloud.updatedAt}
          />
        </div>
        <div className="planner-conflict-actions">
          <button type="button" onClick={onKeepDevice} data-primary-action>
            Keep this device
          </button>
          <button type="button" onClick={onKeepCloud}>
            Keep cloud copy
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
