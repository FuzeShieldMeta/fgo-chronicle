"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  appearanceStorageKey,
  applyAppearance,
  parseAppearance,
  type Appearance,
} from "../_lib/appearance";

const AppearanceContext = createContext<{
  preference: Appearance;
  setAppearance: (preference: Appearance) => void;
}>({ preference: "system", setAppearance: () => undefined });

export function AppearanceProvider({ children }: { children: ReactNode }) {
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

  function setAppearance(next: Appearance) {
    setPreference(next);
    applyAppearance(
      next,
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    );
    try {
      window.localStorage.setItem(appearanceStorageKey, next);
    } catch {
      // Keep the current page usable when browser storage is blocked.
    }
  }

  return (
    <AppearanceContext.Provider value={{ preference, setAppearance }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function AppearanceControl() {
  const { preference, setAppearance } = useContext(AppearanceContext);

  return (
    <label className="appearance-setting">
      <span className="sr-only">Appearance</span>
      <select
        aria-label="Appearance"
        title={`Appearance: ${preference}`}
        value={preference}
        onChange={(event) => setAppearance(parseAppearance(event.target.value))}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
