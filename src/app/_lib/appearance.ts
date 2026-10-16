export const appearanceStorageKey = "fgo-chronicle:appearance:v1";
export const appearanceOptions = ["system", "light", "dark"] as const;
export type Appearance = (typeof appearanceOptions)[number];

export function parseAppearance(value: string | null | undefined): Appearance {
  return appearanceOptions.find((option) => option === value) ?? "system";
}

export function applyAppearance(preference: Appearance, prefersDark: boolean) {
  document.documentElement.dataset.appearance = preference;
  document.documentElement.dataset.theme =
    preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

// Static, application-owned code only. Runs before paint; no user data is embedded.
// Keep validation in step with parseAppearance.
export const appearanceBootstrap = `(()=>{let p="system";try{const v=localStorage.getItem(${JSON.stringify(appearanceStorageKey)});if(${JSON.stringify(appearanceOptions)}.includes(v))p=v}catch{}const r=document.documentElement;r.dataset.appearance=p;r.dataset.theme=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p})()`;
