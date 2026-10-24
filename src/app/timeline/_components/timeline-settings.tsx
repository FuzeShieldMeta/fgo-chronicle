"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { AppearanceControl } from "~/app/_components/appearance-control";
import { TimelinePanelHeader } from "./timeline-panel-header";

type SettingsPanel = "settings" | "account" | "help" | null;

const SettingsContext = createContext<{
  panel: SettingsPanel;
  setPanel: Dispatch<SetStateAction<SettingsPanel>>;
  closePanel: (panel: Exclude<SettingsPanel, null>) => void;
}>({ panel: null, setPanel: () => undefined, closePanel: () => undefined });

export function TimelineSettingsProvider({
  children,
  authError = false,
}: {
  children: ReactNode;
  authError?: boolean;
}) {
  const [panel, setPanel] = useState<SettingsPanel>(
    authError ? "account" : null,
  );
  const closePanel = useCallback((expected: Exclude<SettingsPanel, null>) => {
    setPanel((current) => (current === expected ? null : current));
  }, []);
  return (
    <SettingsContext.Provider value={{ panel, setPanel, closePanel }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useTimelineSettings = () => useContext(SettingsContext);

export function TimelineSettingsButton() {
  const { panel, setPanel } = useTimelineSettings();
  return (
    <button
      id="timeline-settings-button"
      type="button"
      className="timeline-settings-button"
      aria-expanded={panel !== null}
      onClick={() => setPanel("settings")}
    >
      Settings
    </button>
  );
}

export function TimelineSettingsDetails({
  signedIn,
  onClose,
  returnFocusRef,
}: {
  signedIn: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<string | null>;
}) {
  const { setPanel } = useTimelineSettings();
  useLayoutEffect(() => {
    const targetId = returnFocusRef?.current;
    if (!targetId) return;
    returnFocusRef.current = null;
    document.getElementById(targetId)?.focus();
  }, [returnFocusRef]);
  return (
    <aside
      className="timeline-details timeline-settings-details"
      aria-labelledby="timeline-settings-heading"
    >
      <TimelinePanelHeader
        title="Settings"
        headingId="timeline-settings-heading"
        onClose={onClose}
      />
      <section className="timeline-settings-section">
        <h4>Appearance</h4>
        <AppearanceControl />
      </section>
      <section className="timeline-settings-section">
        <h4>Account and sync</h4>
        <p>
          {signedIn
            ? "Your planner syncs to your account."
            : "Your planner is saved in this browser. Sign in to use it on other devices."}
        </p>
        <button
          id="timeline-account-button"
          type="button"
          className="timeline-tonal-button"
          onClick={() => setPanel("account")}
        >
          Account and sync
        </button>
      </section>
      <section className="timeline-settings-section">
        <h4>Help</h4>
        <button
          id="timeline-methodology-button"
          type="button"
          className="timeline-tonal-button"
          onClick={() => setPanel("help")}
        >
          How the forecast works
        </button>
      </section>
    </aside>
  );
}
