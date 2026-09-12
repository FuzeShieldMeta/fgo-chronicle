"use client";

import { signIn, signOut } from "next-auth/react";
import { useEffect, useId, useRef, useState } from "react";

import type { PlannerSyncStatus } from "~/app/timeline/_components/use-planner-state-sync";

export type TimelineAccountUser = {
  id: string;
  name: string | null;
  email: string | null;
};

export function plannerSyncStatusText(status: PlannerSyncStatus) {
  switch (status) {
    case "LOADING":
      return "Checking…";
    case "SAVING":
      return "Saving…";
    case "SAVED":
      return "Up to date";
    case "LOCAL_ONLY":
      return "Could not sync. Changes are saved in this browser.";
    case "CONFLICT":
      return "Sync paused";
    case "LOCAL":
      return "Saved in this browser";
  }
}

export function TimelineAccountMenu({
  user,
  syncStatus,
  onSyncNow,
  onOpenConflict,
}: {
  user: TimelineAccountUser | null;
  syncStatus: PlannerSyncStatus;
  onSyncNow: () => Promise<void>;
  onOpenConflict: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [accountAction, setAccountAction] = useState<
    "SWITCH" | "SIGN_OUT" | null
  >(null);
  const panelId = useId();
  const accountRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstActionRef.current?.focus();

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      accountRef.current
        ?.querySelector<HTMLButtonElement>(".timeline-account-trigger")
        ?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!user) {
    return (
      <div className="timeline-account">
        <button
          type="button"
          onClick={() => void signIn("google", { redirectTo: "/timeline" })}
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  const accountName = user.name ?? user.email ?? "Google account";
  const syncBusy = syncStatus === "LOADING" || syncStatus === "SAVING";
  const actionBusy = accountAction !== null;

  async function changeAccount() {
    setAccountAction("SWITCH");
    try {
      await signOut({ redirect: false });
      await signIn(
        "google",
        { redirectTo: "/timeline" },
        { prompt: "select_account" },
      );
    } finally {
      setAccountAction(null);
    }
  }

  async function leaveAccount() {
    setAccountAction("SIGN_OUT");
    try {
      await signOut({ redirect: false });
      window.location.assign("/timeline");
    } finally {
      setAccountAction(null);
    }
  }

  return (
    <div ref={accountRef} className="timeline-account">
      <button
        type="button"
        className="timeline-account-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account and sync settings for ${accountName}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{accountName}</span>
      </button>

      {open ? (
        <div id={panelId} className="timeline-account-panel">
          <div className="timeline-account-summary">
            <strong>{accountName}</strong>
            {user.name && user.email ? <span>{user.email}</span> : null}
          </div>
          <p className="timeline-account-sync-status" role="status">
            {plannerSyncStatusText(syncStatus)}
          </p>
          <div className="timeline-account-actions">
            {syncStatus === "CONFLICT" ? (
              <button
                ref={firstActionRef}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenConflict();
                }}
              >
                Choose which copy to keep
              </button>
            ) : (
              <button
                ref={firstActionRef}
                type="button"
                disabled={syncBusy || actionBusy}
                onClick={() => void onSyncNow()}
              >
                Sync now
              </button>
            )}
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void changeAccount()}
            >
              {accountAction === "SWITCH"
                ? "Opening Google…"
                : "Change Google account"}
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void leaveAccount()}
            >
              {accountAction === "SIGN_OUT" ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
