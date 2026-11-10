export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";

  const saved = sessionStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
  if (saved) return saved;

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}