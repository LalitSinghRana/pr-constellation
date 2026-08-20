const THEME_STORAGE_KEY = "theme";
export const DEFAULT_THEME = "system";
export const THEME_MODES = Object.freeze(["system", "light", "dark"]);
export const THEME_CHANGE_EVENT = "prc-theme";

export function readStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_MODES.includes(stored) ? stored : DEFAULT_THEME;
}

export function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(mode = readStoredTheme()) {
  return mode === "dark" || (mode === "system" && prefersDark());
}

export function applyTheme(mode) {
  const next = THEME_MODES.includes(mode) ? mode : DEFAULT_THEME;
  if (next === DEFAULT_THEME) {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  }
  document.documentElement.classList.toggle("dark", resolveDark(next));
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
