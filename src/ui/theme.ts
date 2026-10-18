export type ThemeChoice = "light" | "system" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "eam-theme";

export function resolveTheme(choice: ThemeChoice, media: ResolvedTheme): ResolvedTheme {
  return choice === "system" ? media : choice;
}

export function readStoredTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice, media: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(choice, media);
}

export function persistTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    return;
  }
}

export function onChangeMedia(match: { matches: boolean }): ResolvedTheme {
  return match.matches ? "light" : "dark";
}