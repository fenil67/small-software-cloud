/**
 * Rule-based app-type detection.
 *
 * Detection priority (first match wins):
 *   1. Dockerfile present → pass-through (user knows what they're doing)
 *   2. package.json with a start script or "main" field → Node web service
 *   3. requirements.txt + a recognisable WSGI/ASGI entrypoint → Python web service
 *   4. index.html at root (or only static files) → static site
 *   5. Unrecognised → throw with a helpful message
 */

import fs from "fs/promises";
import path from "path";

export type AppType =
  | { kind: "dockerfile" }
  | { kind: "node"; packageManager: "npm" | "pnpm" | "yarn"; startCommand: string }
  | { kind: "python"; server: "gunicorn" | "uvicorn"; entrypoint: string }
  | { kind: "static" };

export async function detectAppType(dir: string): Promise<AppType> {
  const entries = await fs.readdir(dir);
  const has = (name: string) => entries.some((e) => e.toLowerCase() === name.toLowerCase());

  // ─── 1. Existing Dockerfile ───────────────────────────────────────────────
  if (has("Dockerfile") || has("dockerfile")) {
    return { kind: "dockerfile" };
  }

  // ─── 2. Node.js ───────────────────────────────────────────────────────────
  if (has("package.json")) {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw);
    } catch {
      throw new Error("package.json is not valid JSON");
    }

    const scripts = (pkg.scripts as Record<string, string>) ?? {};
    const startCommand = scripts.start ?? scripts["start:prod"] ?? null;

    if (!startCommand && !pkg.main) {
      throw new Error(
        'Found package.json but no "start" script or "main" field. ' +
          'Add a "start" script (e.g. "node index.js") to package.json.'
      );
    }

    const pm = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
      ? "yarn"
      : "npm";

    return {
      kind: "node",
      packageManager: pm,
      startCommand: startCommand ?? `node ${pkg.main}`,
    };
  }

  // ─── 3. Python ────────────────────────────────────────────────────────────
  if (has("requirements.txt")) {
    // Determine WSGI vs ASGI by scanning requirements.txt for known servers/frameworks
    const reqRaw = await fs.readFile(
      path.join(dir, "requirements.txt"),
      "utf8"
    );
    const reqLines = reqRaw.toLowerCase().split("\n");
    const hasAsgi =
      reqLines.some((l) => l.startsWith("fastapi") || l.startsWith("starlette") || l.startsWith("uvicorn"));

    // Find the entrypoint module (e.g. "app", "main", "wsgi", "asgi")
    const entrypointCandidates = ["app.py", "main.py", "wsgi.py", "asgi.py", "server.py"];
    let entryFile: string | null = null;
    for (const candidate of entrypointCandidates) {
      if (has(candidate)) {
        entryFile = candidate.replace(".py", "");
        break;
      }
    }

    // Check Procfile for the app variable name
    if (!entryFile && has("Procfile")) {
      const procfile = await fs.readFile(path.join(dir, "Procfile"), "utf8");
      const webLine = procfile.split("\n").find((l) => l.startsWith("web:"));
      if (webLine) {
        // e.g. "web: gunicorn myapp.wsgi:application"
        const match = webLine.match(/(?:gunicorn|uvicorn)\s+(\S+)/);
        if (match) {
          return {
            kind: "python",
            server: webLine.includes("uvicorn") ? "uvicorn" : "gunicorn",
            entrypoint: match[1],
          };
        }
      }
    }

    if (!entryFile) {
      // Default guess: app.py with an "app" variable
      entryFile = "app";
    }

    return {
      kind: "python",
      server: hasAsgi ? "uvicorn" : "gunicorn",
      entrypoint: `${entryFile}:app`,
    };
  }

  // ─── 4. Static site ───────────────────────────────────────────────────────
  if (has("index.html")) {
    return { kind: "static" };
  }

  // Check whether ALL visible files are static assets (no server code)
  const CODE_EXTENSIONS = new Set([".js", ".ts", ".py", ".rb", ".go", ".rs", ".php"]);
  const hasCode = entries.some((e) => {
    const ext = path.extname(e).toLowerCase();
    return CODE_EXTENSIONS.has(ext);
  });

  if (!hasCode) {
    return { kind: "static" };
  }

  throw new Error(
    "Could not detect app type. Expected one of:\n" +
      "  • package.json with a \"start\" script (Node)\n" +
      "  • requirements.txt + app.py/main.py (Python)\n" +
      "  • index.html (static site)\n" +
      "  • Dockerfile (custom)"
  );
}
