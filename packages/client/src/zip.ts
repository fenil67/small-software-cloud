/**
 * zipDirectory: pack a local folder into a Buffer using archiver,
 * honouring .gitignore patterns via the `ignore` package.
 *
 * Safety checks:
 *  - Refuses the home directory and filesystem root
 *  - Refuses directories without a recognised project marker file
 *  - Hard-ignores secrets, credentials, and heavyweight build artefacts
 *  - Caps total zip size at 50 MB
 *  - Prints top-level entries being uploaded to stderr
 */

import archiver from "archiver";
import fs from "fs";
import os from "os";
import path from "path";
import ignore, { Ignore } from "ignore";
import { PassThrough } from "stream";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Entries that are ALWAYS excluded, regardless of .gitignore.
 * Uses the same pattern syntax as gitignore.
 */
const HARD_IGNORE = [
  // SCM
  ".git",
  ".hg",
  ".svn",
  // Dependencies
  "node_modules",
  "vendor",
  ".pnp.js",
  ".pnp.cjs",
  // Build outputs
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "__pycache__",
  "*.pyc",
  "*.pyo",
  ".pytest_cache",
  ".mypy_cache",
  // Environment & secrets
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  // Cloud credential files
  ".aws",
  ".ssh",
  ".npmrc",
  ".yarnrc",
  "credentials",
  "credentials.json",
  // Misc
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.tmp",
  ".cache",
];

/** A project must have at least one of these files at its root. */
const PROJECT_MARKERS = [
  "package.json",
  "requirements.txt",
  "index.html",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "Gemfile",
  "pyproject.toml",
  "Dockerfile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/** Path segments that are unconditionally excluded (case-sensitive). */
const FORBIDDEN_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadIgnoreRules(dir: string): Ignore {
  const ig = ignore();
  ig.add(HARD_IGNORE);

  const gitignorePath = path.join(dir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    ig.add(content);
  }
  return ig;
}

function hasForbiddenSegment(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  return parts.some((p) => FORBIDDEN_SEGMENTS.has(p));
}

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function zipDirectory(dir: string): Promise<Buffer> {
  const resolvedDir = path.resolve(dir);
  const homeDir = os.homedir();

  // Safety: refuse home directory and filesystem root
  if (resolvedDir === homeDir || resolvedDir === path.parse(resolvedDir).root) {
    throw new Error(
      `Refusing to zip the home directory or filesystem root (${resolvedDir}). ` +
        "Please point to a specific project directory.",
    );
  }

  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Directory not found: ${resolvedDir}`);
  }
  const stat = fs.statSync(resolvedDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedDir}`);
  }

  // Safety: require a project marker
  if (!hasProjectMarker(resolvedDir)) {
    throw new Error(
      `No project marker found in ${resolvedDir}. ` +
        "Expected one of: " +
        PROJECT_MARKERS.join(", ") +
        ". Make sure you are pointing at your project root.",
    );
  }

  const ig = loadIgnoreRules(resolvedDir);

  // Print top-level entries being included (to stderr, so it doesn't pollute stdout)
  const topLevel = fs.readdirSync(resolvedDir);
  const includedTopLevel = topLevel.filter(
    (name) => !ig.ignores(name) && !hasForbiddenSegment(name),
  );
  process.stderr.write(`[ssc] Uploading from: ${resolvedDir}\n`);
  process.stderr.write(`[ssc] Top-level entries: ${includedTopLevel.join(", ")}\n`);

  let totalBytes = 0;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();
    passthrough.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_ZIP_BYTES) {
        archive.abort();
        reject(
          new Error(
            `Zipped project exceeds the 50 MB upload limit (${(totalBytes / 1024 / 1024).toFixed(1)} MB so far). ` +
              "Add large files/directories to .gitignore and try again.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    passthrough.on("end", () => resolve(Buffer.concat(chunks)));
    passthrough.on("error", reject);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", reject);
    archive.pipe(passthrough);

    // Walk directory and add files not matched by ignore rules
    function addDir(absDir: string, relBase: string): void {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

        if (ig.ignores(relPath)) continue;
        if (hasForbiddenSegment(relPath)) continue;
        if (entry.isSymbolicLink()) continue;

        const absPath = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          addDir(absPath, relPath);
        } else if (entry.isFile()) {
          archive.file(absPath, { name: relPath });
        }
      }
    }

    addDir(resolvedDir, "");
    archive.finalize();
  });
}
