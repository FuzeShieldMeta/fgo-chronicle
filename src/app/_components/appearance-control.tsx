"use client";

import { useEffect, useState } from "react";
import {
  appearanceStorageKey,
  applyAppearance,
  parseAppearance,
  type Appearance,
} from "../_lib/appearance";

export function AppearanceControl() {
  const [preference, setPreference] = useState<Appearance>("system");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const current = parseAppearance(
      document.documentElement.dataset.appearance,
    );
    setPreference(current);
    applyAppearance(current, media.matches);

    function followSystem() {
      applyAppearance(
        parseAppearance(document.documentElement.dataset.appearance),
        media.matches,
      );
    }
    function followStorage(event: StorageEvent) {
      if (event.key !== appearanceStorageKey && event.key !== null) return;
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
      const next = parseAppearance(event.newValue);
      setPreference(next);
      applyAppearance(next, media.matches);
    }
    media.addEventListener("change", followSystem);
    window.addEventListener("storage", followStorage);
    return () => {
      media.removeEventListener("change", followSystem);
      window.removeEventListener("storage", followStorage);
    };
  }, []);

  return (
    <label className="timeline-tonal-button timeline-toolbar-action appearance-control">
      <span
        className="timeline-toolbar-action-label"
        data-short-label="Theme"
        aria-hidden="true"
      >
        <span>Appearance</span>
      </span>
      <select
        aria-label="Appearance"
        title={`Appearance: ${preference}`}
        value={preference}
        onChange={(event) => {
          const next = parseAppearance(event.target.value);
          setPreference(next);
          applyAppearance(
            next,
            window.matchMedia("(prefers-color-scheme: dark)").matches,
          );
          try {
            window.localStorage.setItem(appearanceStorageKey, next);
          } catch {
            // The current page still follows the choice when storage is blocked.
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
