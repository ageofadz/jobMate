export type JobmateTheme = "dark" | "light";

const STORAGE_KEY = "jobmate-theme";

export function getStoredTheme(): JobmateTheme {
  if (typeof window === "undefined") {
    return "dark";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

export function applyTheme(theme: JobmateTheme) {
  document.documentElement.setAttribute("data-theme", theme);
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function toggleTheme(current: JobmateTheme): JobmateTheme {
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
