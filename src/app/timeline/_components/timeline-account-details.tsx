"use client";

import { signIn, signOut } from "next-auth/react";
import { useState } from "react";

type AccountAction = "SIGN_IN" | "SWITCH" | "SIGN_OUT" | null;

export type TimelineAccountUser = { id: string };

export function TimelineAccountDetails({
  signedIn,
  authError,
  onClose,
  onBack,
}: {
  signedIn: boolean;
  authError: boolean;
  onClose: () => void;
  onBack?: () => void;
}) {
  const [action, setAction] = useState<AccountAction>(null);

  async function beginSignIn() {
    setAction("SIGN_IN");
    try {
      await signIn("google", { redirectTo: "/timeline" });
    } finally {
      setAction(null);
    }
  }

  async function changeAccount() {
    setAction("SWITCH");
    try {
      await signOut({ redirect: false });
      await signIn(
        "google",
        { redirectTo: "/timeline" },
        { prompt: "select_account" },
      );
    } finally {
      setAction(null);
    }
  }

  async function leaveAccount() {
    setAction("SIGN_OUT");
    try {
      await signOut({ redirectTo: "/timeline" });
    } finally {
      setAction(null);
    }
  }

  return (
    <aside className="timeline-details timeline-sync-details" aria-label="Sync">
      <div className="timeline-details-header">
        <div>
          {onBack ? (
            <button
              type="button"
              className="timeline-search-back"
              onClick={onBack}
            >
              Back to settings
            </button>
          ) : null}
          <span className="timeline-type-label">Optional account sync</span>
          <h3 id="timeline-account-heading">
            {signedIn ? "Account and sync" : "Keep your planner"}
          </h3>
        </div>
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      {signedIn ? (
        <p className="timeline-sync-lead">
          You are signed in. Your changes to the planner will automatically sync
          while you use the timeline.
        </p>
      ) : (
        <>
          <p className="timeline-sync-lead">
            A two-year FGO schedule has a lot to keep track of: events, rewards,
            and summon plans. Sync keeps your planner available on another
            browser or device.
          </p>
          <p className="timeline-sync-storage-note">
            Without an account, the planner uses storage in this browser. That
            copy can be lost if you clear site data, reset the browser, or use a
            cleanup tool that removes browser data. Setting it up again means
            re-entering your balances, reward choices, and summon plans.
          </p>
        </>
      )}

      {authError ? (
        <p className="timeline-sync-error" role="alert">
          Google sign-in did not finish. Try again. Your planner data has not
          been changed.
        </p>
      ) : null}

      {!signedIn ? (
        <div className="timeline-sync-privacy">
          <section>
            <h4>What Google shares</h4>
            <p>
              Google sends an account-specific identifier and your primary email
              address during sign-in. FGO Chronicle keeps the identifier but
              does not save your email address.
            </p>
          </section>
          <section>
            <h4>What the app can access</h4>
            <p>
              FGO Chronicle does not request access to Google Drive, Gmail,
              contacts, calendars, or other Google services.
            </p>
          </section>
          <section>
            <h4>What is stored</h4>
            <p>
              When you sign in, FGO Chronicle stores your planner data, an
              internal user ID, Google&apos;s account-specific identifier, and a
              login session. It does not store your Google name, email address,
              profile photo, or Google access tokens.
            </p>
          </section>
        </div>
      ) : null}

      {signedIn ? (
        <div className="timeline-sync-actions">
          <button
            type="button"
            className="timeline-primary-button"
            disabled={action !== null}
            onClick={() => void changeAccount()}
          >
            {action === "SWITCH" ? "Opening Google…" : "Change Google account"}
          </button>
          <button
            type="button"
            className="timeline-sync-secondary-action"
            disabled={action !== null}
            onClick={() => void leaveAccount()}
          >
            {action === "SIGN_OUT" ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="timeline-primary-button timeline-sync-sign-in"
          disabled={action !== null}
          onClick={() => void beginSignIn()}
        >
          {action === "SIGN_IN" ? "Opening Google…" : "Continue with Google"}
        </button>
      )}
    </aside>
  );
}
