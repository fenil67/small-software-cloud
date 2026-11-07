/**
 * GitHub URL validation, clone argument builder, and post-clone size checker.
 *
 * parseGithubUrl — strict allow-list validator; returns { owner, repo, cloneUrl }
 *   or throws GithubUrlError with a user-safe message.
 *
 * buildCloneArgs — returns the git argv array for a hardened clone.
 *   Exported so tests can verify the flags without running a real clone.
 *
 * checkDirSize — sums file sizes under a directory (excluding .git) and throws
 *   if the total exceeds limitBytes.  limitBytes is a parameter so tests can
 *   inject a small cap without touching production values.
 */

import path from "path";
import fs from "fs";

export class GithubUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubUrlError";
  }
}

export function parseGithubUrl(
  input: string,
): { owner: string; repo: string; cloneUrl: string } {
  // ── 1. Length ────────────────────────────────────────────────────────────────
  if (input.length > 300) {
    throw new GithubUrlError("URL is too long (max 300 characters).");
  }

  // ── 2. No whitespace or control characters anywhere ──────────────────────────
  // \s covers space, tab, newline, carriage-return, etc.
  // [\x00-\x1f\x7f] catches remaining ASCII control codes.
  if (/\s/.test(input) || /[\x00-\x08\x0e-\x1f\x7f]/.test(input)) {
    throw new GithubUrlError("URL must not contain whitespace or control characters.");
  }

  // ── 3. No leading dash (protects against git flag injection) ──────────────────
  if (input.startsWith("-")) {
    throw new GithubUrlError("Invalid URL.");
  }

  // ── 4. Parse ─────────────────────────────────────────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new GithubUrlError("Invalid URL format.");
  }

  // ── 5. Scheme must be exactly https ──────────────────────────────────────────
  if (parsed.protocol !== "https:") {
    throw new GithubUrlError("Only https://github.com URLs are supported.");
  }

  // ── 6. Host must be exactly github.com (no subdomains, no lookalikes) ────────
  if (parsed.hostname !== "github.com") {
    throw new GithubUrlError("Only github.com repositories are supported.");
  }

  // ── 7. No explicit port — URL API normalises away :443, so check raw input ───
  //    Extract authority from raw input string.
  {
    const afterSlashSlash = input.indexOf("//");
    const afterScheme = afterSlashSlash >= 0 ? input.slice(afterSlashSlash + 2) : "";
    const slashPos = afterScheme.indexOf("/");
    const authority = slashPos >= 0 ? afterScheme.slice(0, slashPos) : afterScheme;
    // Strip userinfo prefix (the @ and everything before it).
    const atPos = authority.lastIndexOf("@");
    const hostPart = atPos >= 0 ? authority.slice(atPos + 1) : authority;
    if (/:\d+$/.test(hostPart)) {
      throw new GithubUrlError("URL must not include an explicit port.");
    }
  }

  // ── 8. No credentials ────────────────────────────────────────────────────────
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GithubUrlError("URL must not include credentials.");
  }

  // ── 9. No query string or fragment ──────────────────────────────────────────
  if (parsed.search !== "") {
    throw new GithubUrlError("URL must not include a query string.");
  }
  if (parsed.hash !== "") {
    throw new GithubUrlError("URL must not include a fragment.");
  }

  // ── 10. No percent-encoding anywhere in the path ─────────────────────────────
  if (parsed.pathname.includes("%")) {
    throw new GithubUrlError(
      "URL must not contain percent-encoded characters in the path.",
    );
  }

  // ── 11. Path must be exactly /<owner>/<repo>[.git][/] ────────────────────────
  let cleanPath = parsed.pathname;
  if (cleanPath.endsWith("/")) cleanPath = cleanPath.slice(0, -1);
  if (cleanPath.endsWith(".git")) cleanPath = cleanPath.slice(0, -4);
  if (cleanPath.endsWith("/")) cleanPath = cleanPath.slice(0, -1); // repo/.git/

  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new GithubUrlError(
      "URL must point to a GitHub repository (https://github.com/owner/repo).",
    );
  }

  const [owner, repo] = parts;

  // ── 12. Owner: 1–39 chars, letters/digits/hyphens ───────────────────────────
  if (!/^[a-zA-Z0-9-]{1,39}$/.test(owner)) {
    throw new GithubUrlError("Invalid repository owner name.");
  }

  // ── 13. Repo: 1–100 chars, letters/digits/hyphen/underscore/dot, not "." or ".." ──
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw new GithubUrlError("Invalid repository name.");
  }

  // ── 14. Rebuild canonical URL ─────────────────────────────────────────────────
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  return { owner, repo, cloneUrl };
}

/**
 * Returns the git argv for a hardened, injection-safe clone.
 * The "--" separator before the URL prevents git from mistaking a URL
 * that starts with "-" for a flag (defence-in-depth on top of the validator).
 */
export function buildCloneArgs(cloneUrl: string, dir: string): string[] {
  return [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "core.symlinks=false",
    "clone",
    "--depth=1",
    "--no-tags",
    "--single-branch",
    "--",
    cloneUrl,
    dir,
  ];
}

/**
 * Recursively sums the sizes of all files under dir, skipping the .git directory.
 * Throws a plain Error (user-safe message) if the total exceeds limitBytes.
 * limitBytes is a parameter so tests can inject a small cap.
 */
export async function checkDirSize(dir: string, limitBytes: number): Promise<void> {
  let total = 0;

  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(p);
          total += stat.size;
        } catch {
          // ignore individual stat errors
        }
      }
      if (total > limitBytes) return; // early exit once over limit
    }
  }

  await walk(dir);

  if (total > limitBytes) {
    const capMb = Math.ceil(limitBytes / (1024 * 1024));
    throw new Error(
      `Repository is too large. Maximum repository size is ${capMb} MB.`,
    );
  }
}
