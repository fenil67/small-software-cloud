import { describe, it, expect } from "vitest";
import { appUrl } from "../app-url";

describe("appUrl – normalisation", () => {
  it("bare hostname → adds https://", () => {
    expect(appUrl("ssc-abc12345.fly.dev")).toBe("https://ssc-abc12345.fly.dev");
  });

  it("https:// once → kept as-is (canonical form)", () => {
    expect(appUrl("https://ssc-abc12345.fly.dev")).toBe("https://ssc-abc12345.fly.dev");
  });

  it("https:// twice → normalised (double-scheme from legacy web+API bug)", () => {
    // The API stores "https://ssc-x.fly.dev"; the web prepended https:// again.
    // We strip both prefixes and return the canonical form.
    expect(appUrl("https://https://ssc-abc12345.fly.dev")).toBe("https://ssc-abc12345.fly.dev");
  });

  it("javascript: → null (XSS vector)", () => {
    expect(appUrl("javascript:alert(1)")).toBeNull();
  });

  it("http:// → null (non-https scheme rejected)", () => {
    expect(appUrl("http://ssc-abc12345.fly.dev")).toBeNull();
  });

  it("non-.fly.dev host → null (domain not allowed)", () => {
    expect(appUrl("https://evil.com")).toBeNull();
  });

  it("host ends with .fly.dev.evil.com → null (suffix must be exact)", () => {
    expect(appUrl("https://ssc-x.fly.dev.evil.com")).toBeNull();
  });

  it("userinfo in URL → null (security: auth bypass)", () => {
    expect(appUrl("https://user@ssc-x.fly.dev")).toBeNull();
  });

  it("null → null", () => {
    expect(appUrl(null)).toBeNull();
  });

  it("empty string → null", () => {
    expect(appUrl("")).toBeNull();
  });
});

describe("appUrl – MUTATION: drop host suffix check → test fails", () => {
  it("non-.fly.dev host returns null (mutation: remove endsWith check → 'https://evil.com' would pass)", () => {
    // If the `.endsWith(".fly.dev")` guard is removed, appUrl("https://evil.com") would
    // return "https://evil.com" and this test would fail.
    expect(appUrl("https://evil.com")).toBeNull();
  });
});
