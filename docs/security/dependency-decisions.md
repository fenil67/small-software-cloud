# Dependency Security Decisions

Date: 2026-11-15
Audited with: `pnpm audit` / `pnpm audit --prod`
Post-upgrade state: vitest 4.1.12 installed; all 6 vitest/tinypool/mocker advisories resolved.

---

## Accepted findings (2 moderate, production-impacting)

### 1. glob 10.5.0 — GHSA-3g3m-2fjr-6pw4

| Field | Value |
|---|---|
| Package | `glob@10.5.0` |
| Advisory | GHSA-3g3m-2fjr-6pw4 (#1244013) |
| Severity | Moderate |
| CWE | CWE-400 (resource exhaustion via AbortSignal bypass) |
| Patched in | `glob >= 14.0.2` |
| Dep path | `archiver@7.0.1 → archiver-utils@5.0.2 → glob@10.5.0` |
| Consumers | `packages/client`, `packages/cli` (`@utir/ssc`), `packages/mcp` (`@utir/ssc-mcp`), `apps/api` |
| Ships in production | Published npm packages `@utir/ssc` and `@utir/ssc-mcp` (archiver is bundled as an external runtime dep in both). **Not in the Railway API image**: archiver is a `devDependency` in `apps/api/package-lock.json` and is excluded by `npm ci --omit=dev` at build time. |

**Why not reachable:**
The advisory fires when a caller passes an `AbortSignal` to `glob()` and relies on it to cancel in-flight filesystem traversal after a timeout. `archiver-utils` calls `glob()` only when the archive's `.glob()` or `.directory()` methods are invoked by the caller.

This codebase never calls those methods. The only use of archiver is in `packages/client/src/zip.ts`, which does its own directory walking with `fs.readdirSync` and appends files one at a time via `archive.file()` (line 200). `archiver-utils`' glob is never entered. The `archive.abort()` call at line 168 is archiver's stream abort triggered by a 50 MB size limit — it is unrelated to the `AbortSignal` API that the advisory describes.

**Decision:** Accept. The vulnerable code path (`archiver-utils` glob) is dead code from our perspective.

---

### 2. minimatch 9.0.9 — GHSA-g3hv-75wg-m249 (prod path)

| Field | Value |
|---|---|
| Package | `minimatch@9.0.9` |
| Advisory | GHSA-g3hv-75wg-m249 (#1244623) |
| Severity | Moderate |
| CWE | CWE-405 (asymmetric resource consumption via globparts amplification) |
| Patched in | `minimatch >= 11.0.1` |
| Dep path | `archiver@7.0.1 → archiver-utils@5.0.2 → glob@10.5.0 → minimatch@9.0.9` |
| Consumers | Same as above: `packages/client`, `packages/cli`, `packages/mcp`, `apps/api` |
| Ships in production | Same as glob finding above: `@utir/ssc` and `@utir/ssc-mcp` npm packages only; not in the Railway API image. |

**Why not reachable:**
The exploit requires a crafted glob pattern containing exponentially branching `{a,b,c,...}` constructs to be passed to `minimatch`. minimatch is only reached here as a dependency of `archiver-utils`' glob, which is only called by archiver's `.glob()` / `.directory()` methods — neither of which is ever called (see finding 1 above). Even if the code path were reached, the patterns would be internal archiver constants, not user-controlled input.

A `pnpm.overrides` on minimatch to `>=11.0.1` would force a major version jump (9 → 11) across all consumers and would leave the prod path at minimatch@11 via a future `readdir-glob@3` dependency if archiver is ever upgraded to v8. It is not worth the risk of breakage for a vulnerability with no reachable attack surface.

**Decision:** Accept. Same root cause as finding 1 (archiver-utils glob never entered).

---

## Revisit trigger

> Upgrade `archiver` to v8 as its own task.
> Re-check both findings before any closed beta invite and before the next npm publish of `@utir/ssc` or `@utir/ssc-mcp`.
> When upgrading archiver to v8, also add a `pnpm.overrides` for `minimatch` to `>=11.0.1` to cover the new `readdir-glob@3 → minimatch@^10` path that archiver v8 introduces.

---

## Resolved findings (closed by this upgrade)

The following 6 advisories were present before the vitest upgrade to 4.1.12 and are now resolved:

| Advisory | Package | Was severity | Fixed by |
|---|---|---|---|
| GHSA-5xrq-8626-4rwp | `vitest@3.2.4` | Critical | `vitest@4.1.12` |
| GHSA-5gmw-xhrv-c9v3 | `tinypool@1.1.1` | Critical | `vitest@4.1.12` (bundles tinypool@2.2.0) |
| GHSA-85c8-ppgw-ccpr | `tinypool@1.1.1` | Critical | `vitest@4.1.12` (bundles tinypool@2.2.0) |
| GHSA-82fw-gwwq-j7p9 | `vitest@3.2.4` | Moderate | `vitest@4.1.12` |
| GHSA-82fw-gwwq-j7p9 | `@vitest/mocker@3.2.4` | Moderate | `vitest@4.1.12` |
| GHSA-qxg6-89mg-rqv8 | `@vitest/mocker@3.2.4` | Moderate | `vitest@4.1.12` |

All six were dev-only (not in production), all required the `vitest --ui` browser server to be running and externally accessible, and none appeared in `pnpm audit --prod`.
