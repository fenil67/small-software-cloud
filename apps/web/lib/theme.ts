export const THEME_COOKIE = "utir-theme";

export type Theme = "dark" | "light" | "system";

const VALID: readonly Theme[] = ["dark", "light", "system"];

export function parseTheme(value: unknown): Theme {
  if (typeof value === "string" && VALID.includes(value as Theme)) {
    return value as Theme;
  }
  return "dark";
}

export function themeClass(theme: Theme): string {
  return `t-${theme}`;
}
