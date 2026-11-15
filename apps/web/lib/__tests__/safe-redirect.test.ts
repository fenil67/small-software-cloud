import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "../safe-redirect";

const ORIGIN = "https://app.utir.dev";

// ─── Good relative paths ─────────────────────────────────────────────────────

describe("safeRedirectPath – valid relative paths", () => {
  it("returns /dashboard unchanged", () => {
    expect(safeRedirectPath("/dashboard", ORIGIN)).toBe("/dashboard");
  });

  it("returns / unchanged", () => {
    expect(safeRedirectPath("/", ORIGIN)).toBe("/");
  });

  it("returns path with query string", () => {
    expect(safeRedirectPath("/app?foo=bar", ORIGIN)).toBe("/app?foo=bar");
  });

  it("returns path with hash", () => {
    expect(safeRedirectPath("/settings#tab", ORIGIN)).toBe("/settings#tab");
  });

  it("returns deep path", () => {
    expect(safeRedirectPath("/a/b/c/d", ORIGIN)).toBe("/a/b/c/d");
  });

  it("returns path with percent-encoded safe chars", () => {
    expect(safeRedirectPath("/hello%20world", ORIGIN)).toBe("/hello%20world");
  });
});

// ─── Good absolute same-origin URLs ─────────────────────────────────────────

describe("safeRedirectPath – valid absolute same-origin URLs", () => {
  it("strips origin from same-origin absolute URL", () => {
    expect(safeRedirectPath("https://app.utir.dev/access?app=abc&state=xyz", ORIGIN)).toBe(
      "/access?app=abc&state=xyz",
    );
  });

  it("strips origin from same-origin absolute URL – just slash", () => {
    expect(safeRedirectPath("https://app.utir.dev/", ORIGIN)).toBe("/");
  });

  it("strips origin from same-origin absolute URL – path only", () => {
    expect(safeRedirectPath("https://app.utir.dev/dashboard", ORIGIN)).toBe("/dashboard");
  });
});

// ─── Hostile inputs → "/" ───────────────────────────────────────────────────

describe("safeRedirectPath – hostile inputs return /", () => {
  // Cross-origin absolute URLs
  it("rejects cross-origin absolute URL", () => {
    expect(safeRedirectPath("https://evil.com/access?x=1", ORIGIN)).toBe("/");
  });

  it("rejects subdomain spoof: app.utir.dev.evil.com", () => {
    expect(safeRedirectPath("https://app.utir.dev.evil.com/access", ORIGIN)).toBe("/");
  });

  it("rejects userinfo spoof: app.utir.dev@evil.com", () => {
    expect(safeRedirectPath("https://app.utir.dev@evil.com/access", ORIGIN)).toBe("/");
  });

  it("rejects userinfo in same-origin URL: user:pass@app.utir.dev", () => {
    expect(safeRedirectPath("https://user:pass@app.utir.dev/access", ORIGIN)).toBe("/");
  });

  it("rejects wrong scheme (http vs https)", () => {
    expect(safeRedirectPath("http://app.utir.dev/access", ORIGIN)).toBe("/");
  });

  it("rejects wrong port", () => {
    expect(safeRedirectPath("https://app.utir.dev:8443/access", ORIGIN)).toBe("/");
  });

  it("rejects uppercase host in evil subdomain", () => {
    expect(safeRedirectPath("https://APP.utir.dev.evil.com/", ORIGIN)).toBe("/");
  });

  // Protocol-relative
  it("rejects protocol-relative //evil.com", () => {
    expect(safeRedirectPath("//evil.com", ORIGIN)).toBe("/");
  });

  it("rejects protocol-relative //evil.com/path", () => {
    expect(safeRedirectPath("//evil.com/path", ORIGIN)).toBe("/");
  });

  // No leading slash
  it("rejects path without leading slash", () => {
    expect(safeRedirectPath("dashboard", ORIGIN)).toBe("/");
  });

  it("rejects relative ../escape", () => {
    expect(safeRedirectPath("../secret", ORIGIN)).toBe("/");
  });

  // Backslash open-redirect
  it("rejects backslash redirect /\\evil.com", () => {
    expect(safeRedirectPath("/\\evil.com", ORIGIN)).toBe("/");
  });

  it("rejects encoded backslash /%5Cevil.com", () => {
    expect(safeRedirectPath("/%5Cevil.com", ORIGIN)).toBe("/");
  });

  // Control characters
  it("rejects path with null byte", () => {
    expect(safeRedirectPath("/path\x00evil", ORIGIN)).toBe("/");
  });

  it("rejects path with newline", () => {
    expect(safeRedirectPath("/path\nevil", ORIGIN)).toBe("/");
  });

  it("rejects path with carriage return", () => {
    expect(safeRedirectPath("/path\revil", ORIGIN)).toBe("/");
  });

  // Max length
  it("rejects path longer than 2048 chars", () => {
    expect(safeRedirectPath("/" + "a".repeat(2048), ORIGIN)).toBe("/");
  });

  // Edge types
  it("rejects null input", () => {
    expect(safeRedirectPath(null, ORIGIN)).toBe("/");
  });

  it("rejects undefined input", () => {
    expect(safeRedirectPath(undefined, ORIGIN)).toBe("/");
  });

  it("rejects number input", () => {
    expect(safeRedirectPath(42, ORIGIN)).toBe("/");
  });

  it("rejects empty string", () => {
    expect(safeRedirectPath("", ORIGIN)).toBe("/");
  });

  it("rejects javascript: protocol", () => {
    expect(safeRedirectPath("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  it("rejects data: URI", () => {
    expect(safeRedirectPath("data:text/html,<h1>", ORIGIN)).toBe("/");
  });

  // Encoded protocol-relative variants — caught by decoded.startsWith("//") check
  it("rejects /%2Fevil.com (percent-encoded slash, decoded = //evil.com)", () => {
    // raw: "/%2Fevil.com" → starts with "/" ✓, not "//" raw ✓, decodes to "//evil.com"
    // → rejected by decoded.startsWith("//")
    expect(safeRedirectPath("/%2Fevil.com", ORIGIN)).toBe("/");
  });

  it("rejects %2F%2Fevil.com (no leading slash, rejected early)", () => {
    // raw: "%2F%2Fevil.com" → does NOT start with "/" → rejected by !path.startsWith("/")
    expect(safeRedirectPath("%2F%2Fevil.com", ORIGIN)).toBe("/");
  });
});
