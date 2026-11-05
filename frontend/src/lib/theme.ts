export type Theme = "dark" | "light";

export const THEME_KEY = "hkg-theme";

/** Dark is the default; only an explicit "light" selection switches it off. */
export function parseTheme(stored: string | null | undefined): Theme {
  return stored === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
