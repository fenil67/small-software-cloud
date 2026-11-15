import { describe, it, expect } from "vitest";
import { parseTheme, themeClass, type Theme } from "../theme";

// ─── parseTheme ─────────────────────────────────────────────────────────────

describe("parseTheme", () => {
  it('returns "dark" for "dark"', () => {
    expect(parseTheme("dark")).toBe("dark");
  });

  it('returns "light" for "light"', () => {
    expect(parseTheme("light")).toBe("light");
  });

  it('returns "system" for "system"', () => {
    expect(parseTheme("system")).toBe("system");
  });

  it('returns "dark" for unknown string', () => {
    expect(parseTheme("purple")).toBe("dark");
  });

  it('returns "dark" for empty string', () => {
    expect(parseTheme("")).toBe("dark");
  });

  it('returns "dark" for undefined', () => {
    expect(parseTheme(undefined)).toBe("dark");
  });

  it('returns "dark" for null', () => {
    expect(parseTheme(null)).toBe("dark");
  });

  it('returns "dark" for a number', () => {
    expect(parseTheme(42)).toBe("dark");
  });

  it('returns "dark" for an object', () => {
    expect(parseTheme({})).toBe("dark");
  });

  it("is case-sensitive: DARK → dark (default)", () => {
    expect(parseTheme("DARK")).toBe("dark");
  });

  it("is case-sensitive: Light → dark (default)", () => {
    expect(parseTheme("Light")).toBe("dark");
  });
});

// ─── themeClass ──────────────────────────────────────────────────────────────

describe("themeClass", () => {
  const cases: [Theme, string][] = [
    ["dark", "t-dark"],
    ["light", "t-light"],
    ["system", "t-system"],
  ];

  it.each(cases)('themeClass("%s") === "%s"', (theme, expected) => {
    expect(themeClass(theme)).toBe(expected);
  });
});
