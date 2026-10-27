// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppearanceProvider,
  AppearanceControl,
} from "~/app/_components/appearance-control";
import { appearanceStorageKey } from "~/app/_lib/appearance";

let media: EventTarget & { matches: boolean };
beforeEach(() => {
  // Node can expose its own storage globals; use this test's browser storage.
  const browser = (globalThis as unknown as { jsdom: { window: Window } }).jsdom
    .window;
  vi.stubGlobal("localStorage", browser.localStorage);
  vi.stubGlobal("sessionStorage", browser.sessionStorage);
  window.localStorage.clear();
  document.documentElement.dataset.appearance = "dark";
  document.documentElement.dataset.theme = "dark";
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.appearance;
  delete document.documentElement.dataset.theme;
});
const mount = () =>
  render(
    <AppearanceProvider>
      <AppearanceControl />
    </AppearanceProvider>,
  );

function storageChange(options: StorageEventInit) {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", options));
  });
}

it("mounts with the prepaint preference and removes its actual listeners on unmount", () => {
  const removeMedia = vi.spyOn(media, "removeEventListener");
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const page = mount();
  expect(screen.getByRole("combobox", { name: "Appearance" })).toHaveProperty(
    "value",
    "dark",
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  page.unmount();
  expect(removeMedia).toHaveBeenCalledWith("change", expect.any(Function));
  expect(removeWindow).toHaveBeenCalledWith("storage", expect.any(Function));
  storageChange({ key: appearanceStorageKey, newValue: "light" });
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("follows OS changes only while the user has selected System", async () => {
  const user = userEvent.setup();
  mount();
  const select = screen.getByRole("combobox", { name: "Appearance" });
  await user.selectOptions(select, "light");
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  await user.selectOptions(select, "system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("updates the rendered control and theme when persistent storage is blocked", async () => {
  const user = userEvent.setup();
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  mount();
  const select = screen.getByRole("combobox", { name: "Appearance" });
  await user.selectOptions(select, "light");
  expect((select as HTMLSelectElement).value).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(save).toHaveBeenCalledExactlyOnceWith(appearanceStorageKey, "light");
});

it("follows cross-tab changes without writing preferences or accepting unrelated storage", () => {
  const save = vi.spyOn(Storage.prototype, "setItem");
  mount();
  storageChange({ key: "planner", newValue: "light" });
  expect(document.documentElement.dataset.theme).toBe("dark");
  storageChange({
    key: appearanceStorageKey,
    newValue: "light",
    storageArea: window.sessionStorage,
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  storageChange({
    key: appearanceStorageKey,
    newValue: "light",
    storageArea: window.localStorage,
  });
  expect(screen.getByRole("combobox")).toHaveProperty("value", "light");
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => {
    media.matches = true;
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, newValue: null }),
    );
  });
  expect(document.documentElement.dataset.appearance).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(save).not.toHaveBeenCalled();
});
